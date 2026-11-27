import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import type { FakeAgentScenario, Script, Step, StepContent } from './types.js';

/*
 * A scriptable ACP agent for tests: it answers initialize and the session
 * methods, and plays a scripted turn for each session/prompt. See types.ts
 * for the scenario format and fake-acp-agent.ts for running it over stdio.
 */

export const SCENARIOS_DIR = join(import.meta.dirname, 'scenarios');

export interface FakeAgentOptions {
  /** Diagnostics; never stdout. */
  readonly log?: (message: string) => void;
  /** Persist session histories here so session/load works across restarts. */
  readonly stateDir?: string;
  /** Append each prompt here as a JSON line (`{ sessionId, text }`), so a test can see what the agent was sent. */
  readonly promptLog?: string;
}

interface Session {
  readonly id: string;
  readonly history: acp.SessionUpdate[];
  modeId: string | undefined;
  configOptions: acp.SessionConfigOption[] | undefined;
  turn: AbortController | undefined;
}

class Cancelled extends Error {}

const DEFAULT_PERMISSION_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

const toContent = (content: StepContent): acp.ToolCallContent =>
  content.type === 'text' ? { type: 'content', content: { type: 'text', text: content.text } } : content;

/** The prompt as text: text blocks verbatim, other blocks as a one-line note (plus embedded text). */
export const promptText = (prompt: readonly acp.ContentBlock[]): string =>
  prompt.map((block) => {
    switch (block.type) {
      case 'text':
        return block.text;
      case 'resource_link':
        return `[link ${block.uri}]`;
      case 'resource':
        return 'text' in block.resource ? `[resource ${block.resource.uri}]\n${block.resource.text}` : `[resource ${block.resource.uri}]`;
      default:
        return `[${block.type}]`;
    }
  }).join('\n');

const matches = (rule: NonNullable<FakeAgentScenario['rules']>[number], text: string): boolean =>
  typeof rule.match === 'string'
    ? text.toLowerCase().includes(rule.match.toLowerCase())
    : new RegExp(rule.match.regex, rule.match.flags).test(text);

export const createFakeAgent = (scenario: FakeAgentScenario, options: FakeAgentOptions = {}): acp.AgentApp => {
  const log = options.log ?? (() => {});
  const sessions = new Map<string, Session>();
  const caps = scenario.capabilities ?? {};
  const loadSession = caps.loadSession ?? true;
  const resume = caps.resume ?? true;
  let created = 0;

  const resolveScript = (script: Script | undefined): readonly Step[] => {
    if (script === undefined) {
      return [{ type: 'echo' }];
    }
    if (typeof script === 'string') {
      const named = scenario.scripts?.[script];
      if (!named) {
        throw new Error(`scenario has no script named "${script}"`);
      }
      return named;
    }
    return script;
  };

  const modelOption = (): acp.SessionConfigOption | undefined => scenario.models && {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: scenario.models.currentModelId,
    options: scenario.models.availableModels.map(({ modelId, name, description }) => ({ value: modelId, name, description })),
  };

  const newSession = (id: string): Session => {
    const model = modelOption();
    const configOptions = [...(model ? [model] : []), ...(scenario.configOptions ?? [])];
    const session: Session = {
      id,
      history: [],
      modeId: scenario.modes?.currentModeId,
      configOptions: configOptions.length ? configOptions : undefined,
      turn: undefined,
    };
    sessions.set(id, session);
    return session;
  };

  /** What session/new, load and resume return besides the id. */
  const sessionState = (session: Session) => ({
    ...(scenario.modes ? { modes: { ...scenario.modes, currentModeId: session.modeId ?? scenario.modes.currentModeId } } : {}),
    ...(session.configOptions ? { configOptions: session.configOptions } : {}),
    // Not in ACP v1 any more; some clients still read it.
    ...(scenario.models ? { models: scenario.models } : {}),
  });

  const statePath = (id: string): string | undefined =>
    options.stateDir ? join(options.stateDir, `${encodeURIComponent(id)}.json`) : undefined;

  const saveHistory = (session: Session): void => {
    const path = statePath(session.id);
    if (path) {
      mkdirSync(options.stateDir!, { recursive: true });
      writeFileSync(path, JSON.stringify(session.history, null, 2));
    }
  };

  const nextSessionId = (): string => {
    for (;;) {
      created++;
      const id = scenario.sessionId
        ? created === 1 ? scenario.sessionId : `${scenario.sessionId}-${created}`
        : `fake-session-${created}`;
      const path = statePath(id);
      if (!sessions.has(id) && !(path && existsSync(path))) {
        return id;
      }
    }
  };

  /** Plays steps for one session; `signal` aborts the turn. */
  const play = async (
    client: acp.AgentContext,
    session: Session,
    prompt: readonly acp.ContentBlock[],
    steps: readonly Step[],
    signal: AbortSignal,
    instant = false,
  ): Promise<acp.StopReason | undefined> => {
    const wait = async (ms: number | undefined): Promise<void> => {
      if (signal.aborted) {
        throw new Cancelled();
      }
      if (ms && !instant) {
        await sleep(ms, undefined, { signal }).catch(() => {
          throw new Cancelled();
        });
      }
    };
    const send = async (update: acp.SessionUpdate): Promise<void> => {
      if (signal.aborted) {
        throw new Cancelled();
      }
      session.history.push(update);
      await client.notify('session/update', { sessionId: session.id, update });
    };
    const stream = async (kind: 'agent_message_chunk' | 'agent_thought_chunk', text: string, charsPerTick?: number, tickMs = 50): Promise<void> => {
      const size = !instant && charsPerTick && charsPerTick > 0 ? charsPerTick : text.length || 1;
      const chars = [...text];
      for (let i = 0; i < chars.length; i += size) {
        if (i > 0) {
          await wait(tickMs);
        }
        await send({ sessionUpdate: kind, content: { type: 'text', text: chars.slice(i, i + size).join('') } });
      }
    };

    for (const step of steps) {
      await wait(step.delayMs);
      switch (step.type) {
        case 'message':
          await stream('agent_message_chunk', step.text, step.charsPerTick, step.tickMs);
          break;
        case 'thought':
          await stream('agent_thought_chunk', step.text, step.charsPerTick, step.tickMs);
          break;
        case 'user':
          await send({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: step.text } });
          break;
        case 'echo': {
          const body = step.format === 'json' ? `\`\`\`json\n${JSON.stringify(prompt, null, 2)}\n\`\`\`` : promptText(prompt);
          await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: (step.prefix ?? '') + body } });
          break;
        }
        case 'tool_call':
          await send({
            sessionUpdate: 'tool_call',
            toolCallId: step.id,
            title: step.title,
            kind: step.kind ?? 'other',
            status: step.status ?? 'pending',
            ...(step.locations ? { locations: step.locations } : {}),
            ...(step.content ? { content: step.content.map(toContent) } : {}),
            ...(step.rawInput !== undefined ? { rawInput: step.rawInput } : {}),
          });
          break;
        case 'tool_update':
          await send({
            sessionUpdate: 'tool_call_update',
            toolCallId: step.id,
            ...(step.status ? { status: step.status } : {}),
            ...(step.title ? { title: step.title } : {}),
            ...(step.kind ? { kind: step.kind } : {}),
            ...(step.locations ? { locations: step.locations } : {}),
            ...(step.content ? { content: step.content.map(toContent) } : {}),
            ...(step.rawOutput !== undefined ? { rawOutput: step.rawOutput } : {}),
          });
          break;
        case 'plan':
          await send({ sessionUpdate: 'plan', entries: step.entries });
          break;
        case 'mode':
          session.modeId = step.modeId;
          await send({ sessionUpdate: 'current_mode_update', currentModeId: step.modeId });
          break;
        case 'update':
          await send(step.update);
          break;
        case 'wait':
          await wait(step.ms);
          break;
        case 'permission': {
          if (instant) {
            break;
          }
          const permissionOptions = step.options ?? DEFAULT_PERMISSION_OPTIONS;
          const request = client.request('session/request_permission', {
            sessionId: session.id,
            toolCall: {
              toolCallId: step.toolCall.id,
              ...(step.toolCall.title ? { title: step.toolCall.title } : {}),
              ...(step.toolCall.kind ? { kind: step.toolCall.kind } : {}),
              ...(step.toolCall.locations ? { locations: step.toolCall.locations } : {}),
              ...(step.toolCall.content ? { content: step.toolCall.content.map(toContent) } : {}),
            },
            options: permissionOptions,
          });
          const aborted = new Promise<never>((_, reject) => {
            const fail = (): void => reject(new Cancelled());
            if (signal.aborted) {
              fail();
            }
            signal.addEventListener('abort', fail, { once: true });
          });
          const { outcome } = await Promise.race([request, aborted]);
          log(`permission ${step.toolCall.id}: ${JSON.stringify(outcome)}`);
          let branch: Script | undefined;
          if (outcome.outcome === 'selected') {
            const kind = permissionOptions.find((option) => option.optionId === outcome.optionId)?.kind;
            branch = step.branches?.[outcome.optionId] ?? (kind && step.branches?.[kind]) ?? step.branches?.default;
          } else {
            branch = step.branches?.cancelled;
            if (!branch) {
              throw new Cancelled();
            }
          }
          if (branch) {
            const stop = await play(client, session, prompt, resolveScript(branch), signal);
            if (stop) {
              return stop;
            }
          }
          break;
        }
        case 'error':
          if (!instant) {
            throw new acp.RequestError(step.code ?? -32603, step.message, step.data);
          }
          break;
        case 'end':
          if (!instant) {
            return step.stopReason;
          }
          break;
      }
    }
    return undefined;
  };

  const requireSession = (id: string): Session => {
    const session = sessions.get(id);
    if (!session) {
      throw acp.RequestError.sessionNotFound(id);
    }
    return session;
  };

  return acp.agent({ name: 'fake-acp-agent' })
    .onRequest('initialize', ({ params }) => {
      log(`initialize from ${params.clientInfo?.name ?? 'a client'} (protocol ${params.protocolVersion})`);
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: scenario.agentInfo ?? { name: 'fake-acp-agent', title: 'Fake ACP agent', version: '1.0.0' },
        agentCapabilities: {
          loadSession,
          promptCapabilities: { image: caps.image ?? false, audio: false, embeddedContext: caps.embeddedContext ?? true },
          sessionCapabilities: resume ? { resume: {} } : {},
          ...scenario.agentCapabilities,
        },
        authMethods: [],
      };
    })
    .onRequest('authenticate', () => ({}))
    .onRequest('session/new', () => {
      const session = newSession(nextSessionId());
      log(`session/new → ${session.id}`);
      return { sessionId: session.id, ...sessionState(session) };
    })
    .onRequest('session/load', async ({ params, client, signal }) => {
      if (!loadSession) {
        throw acp.RequestError.methodNotFound('session/load');
      }
      const existing = sessions.get(params.sessionId);
      const session = existing ?? newSession(params.sessionId);
      const path = statePath(params.sessionId);
      if (existing) {
        const updates = [...existing.history];
        existing.history.length = 0;
        for (const update of updates) {
          await client.notify('session/update', { sessionId: session.id, update });
          session.history.push(update);
        }
      } else if (path && existsSync(path)) {
        for (const update of JSON.parse(readFileSync(path, 'utf8')) as acp.SessionUpdate[]) {
          session.history.push(update);
          await client.notify('session/update', { sessionId: session.id, update });
        }
      } else {
        const steps = scenario.history?.[params.sessionId] ?? scenario.history?.['*'];
        if (!steps) {
          sessions.delete(params.sessionId);
          throw acp.RequestError.sessionNotFound(params.sessionId);
        }
        await play(client, session, [], steps, signal, true);
      }
      log(`session/load ${session.id}: replayed ${session.history.length} updates`);
      return sessionState(session);
    })
    .onRequest('session/resume', ({ params }) => {
      if (!resume) {
        throw acp.RequestError.methodNotFound('session/resume');
      }
      const session = sessions.get(params.sessionId) ?? newSession(params.sessionId);
      log(`session/resume ${session.id}`);
      return sessionState(session);
    })
    .onRequest('session/set_mode', async ({ params, client }) => {
      const session = requireSession(params.sessionId);
      session.modeId = params.modeId;
      await client.notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId } });
      return {};
    })
    .onRequest('session/set_config_option', ({ params }) => {
      const session = requireSession(params.sessionId);
      session.configOptions = session.configOptions?.map((option) =>
        option.id === params.configId && option.type === 'select' ? { ...option, currentValue: String(params.value) } : option);
      return { configOptions: session.configOptions ?? [] };
    })
    .onRequest('session/prompt', async ({ params, client, signal }) => {
      const session = requireSession(params.sessionId);
      session.turn?.abort();
      const turn = new AbortController();
      session.turn = turn;
      const both = AbortSignal.any([turn.signal, signal]);
      for (const block of params.prompt) {
        session.history.push({ sessionUpdate: 'user_message_chunk', content: block });
      }

      const text = promptText(params.prompt);
      if (options.promptLog) {
        appendFileSync(options.promptLog, `${JSON.stringify({ sessionId: session.id, text })}\n`);
      }
      const rule = scenario.rules?.find((candidate) => matches(candidate, text));
      log(`session/prompt ${session.id}: ${rule ? `rule ${JSON.stringify(rule.match)}` : 'default script'}`);
      try {
        const stopReason = await play(client, session, params.prompt, resolveScript(rule?.script ?? scenario.defaultScript), both);
        log(`turn ended: ${stopReason ?? 'end_turn'}`);
        return { stopReason: stopReason ?? 'end_turn' };
      } catch (error) {
        if (error instanceof Cancelled || both.aborted) {
          log('turn cancelled');
          return { stopReason: 'cancelled' };
        }
        throw error;
      } finally {
        if (session.turn === turn) {
          session.turn = undefined;
        }
        saveHistory(session);
      }
    })
    .onNotification('session/cancel', ({ params }) => {
      log(`session/cancel ${params.sessionId}`);
      sessions.get(params.sessionId)?.turn?.abort();
    });
};

/**
 * Loads a scenario from a JSON or TS file, or by name from the bundled
 * scenarios directory (`markdown-showcase`, `echo`, …).
 */
export const loadScenario = async (pathOrName: string): Promise<FakeAgentScenario> => {
  const candidates = isAbsolute(pathOrName) || existsSync(resolve(pathOrName))
    ? [resolve(pathOrName)]
    : ['.ts', '.json'].map((extension) => join(SCENARIOS_DIR, `${pathOrName}${extension}`));
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(`fake agent scenario not found: ${pathOrName}`);
  }
  if (extname(path) === '.json') {
    return JSON.parse(readFileSync(path, 'utf8')) as FakeAgentScenario;
  }
  const module = await import(pathToFileURL(path).href) as { default?: FakeAgentScenario };
  if (!module.default) {
    throw new Error(`${path} has no default export`);
  }
  return module.default;
};
