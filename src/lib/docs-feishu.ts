/**
 * Feishu Docx block tree -> Markdown conversion.
 *
 * The block list returned by `/open-apis/docx/v1/documents/{id}/blocks` is flat;
 * nesting is expressed through each block's `children` ids, and containers such as
 * tables reference their cells the same way. We rebuild the documented order from
 * the page root and fall back to the flat order when the tree is unavailable.
 */

/** Inline reference to another Feishu document ("引用文档"). */
export interface FeishuMentionDoc {
  token?: string;
  title?: string;
  url?: string;
}
export interface FeishuTextStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  inline_code?: boolean;
  link?: { url?: string };
  /** Feishu has shipped the mention under the style at least once; accept both shapes. */
  mention_doc?: FeishuMentionDoc;
}
export type FeishuTextElement = {
  text_run?: { content?: string; text_element_style?: FeishuTextStyle };
  mention_doc?: FeishuMentionDoc;
};
export type FeishuTextBlock = { elements?: FeishuTextElement[] };

export interface FeishuBlock {
  block_id?: string;
  block_type?: number;
  children?: string[];
  page?: FeishuTextBlock;
  text?: FeishuTextBlock;
  heading1?: FeishuTextBlock;
  heading2?: FeishuTextBlock;
  heading3?: FeishuTextBlock;
  heading4?: FeishuTextBlock;
  heading5?: FeishuTextBlock;
  heading6?: FeishuTextBlock;
  heading7?: FeishuTextBlock;
  heading8?: FeishuTextBlock;
  heading9?: FeishuTextBlock;
  bullet?: FeishuTextBlock;
  ordered?: FeishuTextBlock;
  code?: { elements?: FeishuTextElement[]; style?: { language?: number | string } };
  quote?: FeishuTextBlock;
  todo?: { elements?: FeishuTextElement[]; style?: { done?: boolean } };
  callout?: FeishuTextBlock;
  table?: { property?: { row_size?: number; column_size?: number }; cells?: string[] };
  image?: { token?: string };
  file?: { token?: string; name?: string };
}

const BLOCK_PAGE = 1;
const HEADING_FIRST = 3;
const HEADING_LAST = 11;
const BLOCK_BULLET = 12;
const BLOCK_ORDERED = 13;
const BLOCK_CODE = 14;
const BLOCK_QUOTE = 15;
const BLOCK_TODO = 17;
const BLOCK_CALLOUT = 19;
const BLOCK_DIVIDER = 22;
const BLOCK_FILE = 23;
const BLOCK_IMAGE = 27;
const BLOCK_TABLE = 31;
const BLOCK_TABLE_CELL = 32;
const MAX_HEADING = 6;
const INDENT = '  ';
const MAX_ATTACHMENT_NAME = 120;
const ATTACHMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

type WalkFn = (ids: string[] | undefined, depth: number, counters: number[]) => void;

/** Emphasis markers must sit inside the text run, never around its padding. */
function wrap(value: string, marker: string): string {
  const lead = /^\s*/.exec(value)?.[0] ?? '';
  const trail = /\s*$/.exec(value)?.[0] ?? '';
  const core = value.slice(lead.length, value.length - trail.length);
  return core ? `${lead}${marker}${core}${marker}${trail}` : value;
}

function textElements(payload?: FeishuTextBlock): string {
  return payload?.elements?.map((element) => {
    const mention = element.mention_doc;
    if (mention) return mentionDoc(mention);
    const run = element.text_run;
    const style = run?.text_element_style;
    let content = run?.content ?? '';
    if (!content) return '';
    if (style?.inline_code) {
      content = wrap(content.replace(/`/g, ''), '`');
    } else if (style?.bold && style?.italic) {
      content = wrap(content, '***');
    } else if (style?.bold) {
      content = wrap(content, '**');
    } else if (style?.italic) {
      content = wrap(content, '*');
    }
    if (style?.strikethrough) content = wrap(content, '~~');
    const url = style?.link?.url;
    if (url && /^https?:\/\//.test(url)) return `[${content}](${url})`;
    // Some responses carry the referenced document on the run style instead of the element.
    const styled = style?.mention_doc;
    if (styled && /^https?:\/\//.test(styled.url ?? '')) {
      return `[${content || styled.title?.trim() || ''}](${styled.url})`;
    }
    return content;
  }).join('') ?? '';
}

/** Referenced documents link out to Feishu; without a URL only the title survives. */
function mentionDoc(mention: FeishuMentionDoc): string {
  const title = mention.title?.trim() ?? '';
  const url = mention.url?.trim() ?? '';
  if (title && /^https?:\/\//.test(url)) return `[${title}](${url})`;
  return title || url;
}

/**
 * Filesystem- and URL-safe attachment name. CJK is kept because it survives a
 * percent-encoded round trip; everything else outside `[A-Za-z0-9._-]` collapses
 * to `-`, which also removes any path separators or markdown delimiters.
 */
export function attachmentFileName(name: string | undefined): string {
  const cleaned = (name ?? '')
    .normalize('NFC')
    .replace(/[^A-Za-z0-9._㐀-鿿-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-\./g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+/, '')
    .trim();
  return cleaned.slice(0, MAX_ATTACHMENT_NAME) || 'attachment';
}

function blockText(block: FeishuBlock): string {
  return textElements(block.text ?? block.page ?? block.quote ?? block.callout);
}

/** Quote/callout bodies are multi-line; every line needs its own marker. */
function asQuote(value: string): string {
  return value.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
}

function asFence(block: FeishuBlock): string {
  const language = block.code?.style?.language;
  const info = typeof language === 'string' ? language.trim() : '';
  return `\`\`\`${info}\n${textElements(block.code)}\n\`\`\``;
}

function asTableRow(cells: string[]): string {
  return `| ${cells.map((cell) => cell.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')).join(' | ')} |`;
}

/**
 * Convert the flat block list into markdown.
 *
 * Feishu heading levels are shifted down one so in-document headings always sit
 * below the page title: `heading1` becomes `##`, `heading2` becomes `###`.
 */
export function blocksToMarkdown(items: FeishuBlock[]): string {
  if (!items.length) return '';
  const index = new Map<string, FeishuBlock>();
  for (const item of items) if (item.block_id) index.set(item.block_id, item);
  const lines: string[] = [];
  const visited = new Set<string>();

  /**
   * List items are joined tightly so nested items stay inside their parent list
   * instead of being split into separate lists by a blank line.
   */
  const renderListBlock = (block: FeishuBlock, depth: number, counters: number[], walk: WalkFn): string => {
    const type = block.block_type ?? 0;
    const text = textElements(block.bullet ?? block.ordered).trim();
    counters.length = depth + 1;
    let marker = '-';
    if (type === BLOCK_ORDERED) {
      counters[depth] = (counters[depth] ?? 0) + 1;
      marker = `${counters[depth]}.`;
    }
    const parts: string[] = text ? [`${INDENT.repeat(depth)}${marker} ${text}`] : [];
    for (const id of block.children ?? []) {
      const child = index.get(id);
      if (!child || visited.has(id)) continue;
      visited.add(id);
      if (child.block_type === BLOCK_BULLET || child.block_type === BLOCK_ORDERED) {
        parts.push(renderListBlock(child, depth + 1, counters, walk));
        continue;
      }
      const before = lines.length;
      emit(child, depth + 1, counters, walk);
      parts.push(lines.splice(before).join('\n\n'));
    }
    return parts.filter(Boolean).join('\n');
  };

  const emit = (block: FeishuBlock, depth: number, counters: number[], walk: WalkFn): void => {
    const type = block.block_type ?? 0;
    if (type >= HEADING_FIRST && type <= HEADING_LAST) {
      const level = Math.min(type - 1, MAX_HEADING);
      // Feishu documents routinely carry empty heading blocks; left alone they
      // render as stray empty <h2>/<h3> elements.
      const heading = textElements(block[`heading${type - 2}` as keyof FeishuBlock] as FeishuTextBlock | undefined).trim();
      if (heading) lines.push(`${'#'.repeat(level)} ${heading}`);
      counters.length = 0;
      walk(block.children, depth, counters);
      return;
    }
    if (type === BLOCK_BULLET || type === BLOCK_ORDERED) {
      const rendered = renderListBlock(block, depth, counters, walk);
      if (rendered) lines.push(rendered);
      return;
    }
    if (type === BLOCK_IMAGE) {
      lines.push(`![飞书图片](@@FEISHU_ASSET:${block.image?.token ?? block.block_id}@@)`);
      return;
    }
    if (type === BLOCK_FILE) {
      const token = (block.file?.token ?? '').trim();
      const name = block.file?.name?.trim() ?? '';
      // Without a usable token the file cannot be mirrored, but its name still has to survive.
      if (!token || !ATTACHMENT_TOKEN_PATTERN.test(token)) {
        if (name) lines.push(name);
        return;
      }
      lines.push(`[${name || '附件'}](@@FEISHU_FILE:${token}:${attachmentFileName(name)}@@)`);
      return;
    }
    if (type === BLOCK_TABLE) {
      const cells = block.table?.cells ?? [];
      const columns = block.table?.property?.column_size ?? 0;
      if (cells.length && columns > 0) {
        const rows: string[][] = [];
        for (let start = 0; start < cells.length; start += columns) {
          rows.push(cells.slice(start, start + columns).map((id) => {
            // Cells are consumed here, so keep a later pass from re-emitting them.
            visited.add(id);
            return blockText(index.get(id) ?? {});
          }));
        }
        if (rows.length) {
          // Rows must stay on adjacent lines or the table loses its header separator.
          lines.push([asTableRow(rows[0]), asTableRow(rows[0].map(() => '---')), ...rows.slice(1).map(asTableRow)].join('\n'));
          return;
        }
      }
    }
    if (type === BLOCK_DIVIDER) {
      lines.push('---');
      return;
    }
    if (type === BLOCK_TABLE_CELL) return;
    if (type === BLOCK_CODE) {
      lines.push(asFence(block));
      return;
    }
    if (type === BLOCK_TODO) {
      lines.push(`${INDENT.repeat(depth)}- [${block.todo?.style?.done ? 'x' : ' '}] ${textElements(block.todo).trim()}`);
      return;
    }
    if (type === BLOCK_QUOTE || type === BLOCK_CALLOUT) {
      const text = blockText(block);
      if (text.trim()) lines.push(asQuote(text));
      walk(block.children, depth, counters);
      return;
    }
    const text = blockText(block);
    if (text.trim()) lines.push(text);
    walk(block.children, depth, counters);
  };

  const walk: WalkFn = (ids, depth, counters) => {
    for (const id of ids ?? []) {
      const block = index.get(id);
      if (!block || visited.has(id)) continue;
      visited.add(id);
      emit(block, depth, counters, walk);
    }
  };

  const root = items.find((item) => item.block_type === BLOCK_PAGE && item.children?.length);
  if (root) {
    walk(root.children, 0, []);
  } else {
    // Legacy flat fallback: nothing to recurse into, emit blocks in list order.
    const noRecursion: WalkFn = () => {};
    for (const item of items) {
      if (item.block_type === BLOCK_PAGE || item.block_type === BLOCK_TABLE_CELL) continue;
      emit(item, 0, [], noRecursion);
    }
  }
  return lines.join('\n\n');
}
