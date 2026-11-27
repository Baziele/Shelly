import {
  BoxRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  TextRenderable,
  type CliRenderer,
  type MarkdownBlock,
  type Renderable,
} from '@opentui/core';
import { theme } from '../theme.js';
import { highlightCodeLine } from './code-highlight.js';
import { sanitizeText } from './lines.js';
import { toStyledText } from './styled.js';

/** Markdown styles in the terminal's own palette. Syntax markers are concealed. */
export const createMarkdownStyle = (renderer: CliRenderer): SyntaxStyle => {
  const heading = { fg: theme.accent, bold: true };
  return SyntaxStyle.fromStyles({
    conceal: { fg: theme.muted },
    'markup.heading.1': heading,
    'markup.heading.2': heading,
    'markup.heading.3': { bold: true },
    'markup.heading.4': { bold: true },
    'markup.heading.5': { bold: true },
    'markup.heading.6': { bold: true },
    'markup.heading': { bold: true },
    'markup.strong': { bold: true },
    'markup.italic': { italic: true },
    'markup.strikethrough': { strikethrough: true },
    'markup.raw': { fg: theme.code },
    'markup.link': { fg: theme.link, underline: true },
    'markup.link.label': { fg: theme.link, underline: true },
    'markup.link.url': { fg: theme.muted },
    'markup.list': { fg: theme.muted },
    'markup.quote': { fg: theme.muted, italic: true },
  }, (renderer as unknown as { nativeScene: Parameters<typeof SyntaxStyle.fromStyles>[1] }).nativeScene);
};

interface CodeBlockView {
  readonly box: BoxRenderable;
  readonly text: TextRenderable;
}

/** Where a streaming message can be cut: rows above `row` and source before `byteOffset` are final. */
export interface StableSplit {
  readonly row: number;
  readonly byteOffset: number;
}

interface NativeBlock {
  readonly parent: number | null | undefined;
  readonly sourceStart: number;
}

/**
 * One agent message: streaming markdown in a box. Finished top-level blocks
 * at its start can be cut off and committed while the rest still streams;
 * the view then shows only the remaining source.
 */
export class MessageView {
  readonly root: BoxRenderable;
  readonly markdown: MarkdownRenderable;
  /** UTF-16 offset into the message text where the shown source starts. */
  private shownFrom = 0;
  private text = '';
  private readonly codeBlocks = new Map<number, CodeBlockView>();

  constructor(private readonly renderer: CliRenderer, style: SyntaxStyle) {
    this.root = new BoxRenderable(renderer, { flexDirection: 'column', width: '100%', flexShrink: 0 });
    this.markdown = new MarkdownRenderable(renderer, {
      syntaxStyle: style,
      fg: theme.text,
      conceal: true,
      streaming: true,
      width: '100%',
      flexShrink: 0,
      tableOptions: { style: 'grid', widthMode: 'content', borderColor: theme.muted, wrapMode: 'word', cellPaddingX: 1 },
      renderBlock: (block) => (block.kind === 'code' ? this.renderCode(block) : undefined),
    });
    this.root.add(this.markdown);
  }

  /** The gap above the message; once its start is in scrollback, the gap went with it. */
  set gapBefore(gap: boolean) {
    this.root.marginTop = gap && this.shownFrom === 0 ? 1 : 0;
  }

  update(text: string, final: boolean): void {
    if (text !== this.text) {
      this.text = text;
      this.markdown.content = text.slice(this.shownFrom);
    }
    this.markdown.streaming = !final;
  }

  /**
   * Where the shown source can be cut, per the last layout: before the first
   * top-level block that is not final yet. Undefined when nothing can be cut,
   * or when OpenTUI's document does not look the way this code expects.
   */
  stableSplit(): StableSplit | undefined {
    const committed = this.markdown.committedBlockCount;
    if (committed <= 0) {
      return undefined;
    }
    const doc = (this.markdown as unknown as { _doc?: { blocks?: readonly NativeBlock[] } })._doc;
    const blocks = doc?.blocks;
    const children = this.markdown.getChildren();
    if (!Array.isArray(blocks)) {
      return undefined;
    }
    const topLevel = blocks.filter((block) => block.parent === null || block.parent === undefined || block.parent === -1);
    if (topLevel.length !== children.length || committed >= children.length) {
      return undefined;
    }
    const next = children[committed]!;
    const byteOffset = topLevel[committed]!.sourceStart;
    const row = next.y - this.markdown.y;
    if (!Number.isInteger(byteOffset) || byteOffset <= 0 || row <= 0) {
      return undefined;
    }
    return { row, byteOffset };
  }

  /** Drop the source before `byteOffset` (of the shown source) once its rows are in scrollback. */
  cut(byteOffset: number): void {
    const shown = this.text.slice(this.shownFrom);
    const cutChars = Buffer.from(shown, 'utf8').subarray(0, byteOffset).toString('utf8').length;
    this.shownFrom += cutChars;
    this.root.marginTop = 0;
    this.clearCodeBlocks();
    this.markdown.content = this.text.slice(this.shownFrom);
  }

  destroy(): void {
    this.clearCodeBlocks();
    this.root.destroyRecursively();
  }

  private clearCodeBlocks(): void {
    for (const view of this.codeBlocks.values()) {
      if (!view.box.isDestroyed) {
        view.box.destroyRecursively();
      }
    }
    this.codeBlocks.clear();
  }

  /** Code blocks: a muted gutter, lightly highlighted code, wrapped by character. */
  private renderCode(block: MarkdownBlock): Renderable {
    let view = this.codeBlocks.get(block.index);
    if (!view || view.box.isDestroyed) {
      const box = new BoxRenderable(this.renderer, {
        width: '100%',
        flexShrink: 0,
        flexDirection: 'column',
        border: ['left'],
        borderColor: theme.muted,
        paddingLeft: 1,
      });
      const text = new TextRenderable(this.renderer, { content: '', wrapMode: 'char', width: '100%' });
      box.add(text);
      view = { box, text };
      this.codeBlocks.set(block.index, view);
    }
    const language = (block.lang ?? '').toLowerCase();
    const code = sanitizeText(block.text).replace(/\n$/, '');
    view.text.content = toStyledText((code === '' ? [''] : code.split('\n')).map((line) => highlightCodeLine(line, language)));
    return view.box;
  }
}
