/*
 * Masks secrets in commands and output before they can be sent anywhere.
 * Best effort: it catches well-known token formats and obvious assignments,
 * not every secret a program might print.
 */

const MASK = '[redacted]';

const PATTERNS: ReadonlyArray<readonly [pattern: RegExp, replace: string]> = [
  // PEM private keys, whole block.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `-----BEGIN PRIVATE KEY----- ${MASK}`],
  // Well-known token formats.
  [/\b(?:sk|pk|rk)-(?:[a-z]+-)?[A-Za-z0-9_-]{20,}/g, MASK], // OpenAI, Anthropic, Stripe-style keys
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, MASK], // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, MASK], // GitLab
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, MASK], // Slack
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK], // AWS access key IDs
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK], // Google API keys
  [/\bnpm_[A-Za-z0-9]{36}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, MASK], // JWTs
  // Credentials in URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // Authorization headers.
  [/\b(authorization:\s*(?:bearer|basic|token)\s+)[^\s'"]+/gi, `$1${MASK}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, `$1${MASK}`],
  // NAME=value and "name": "value" where the name says it is a secret and the
  // value is long enough to be one (so max_tokens=1000 survives).
  [
    /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;]{8,}/gi,
    `$1${MASK}`,
  ],
  // Flags: --password value, --token=value
  [/(--?(?:password|passwd|token|secret|api-key)(?:=|\s+))(?!\[redacted\])[^\s"']+/gi, `$1${MASK}`],
];

export const redactSecrets = (text: string): string =>
  PATTERNS.reduce((result, [pattern, replace]) => result.replace(pattern, replace), text);
