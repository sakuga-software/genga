import { z } from 'zod';

export type RichTextMark = { type: string; attrs?: Record<string, unknown> };
export type RichTextNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichTextNode[];
  marks?: RichTextMark[];
  text?: string;
};
export type RichTextDoc = { type: 'doc'; content?: RichTextNode[] };

const nodeSchema: z.ZodType<RichTextNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(nodeSchema).optional(),
    marks: z.array(z.object({ type: z.string(), attrs: z.record(z.string(), z.unknown()).optional() })).optional(),
    text: z.string().optional(),
  }),
);

export const richTextDocSchema = z
  .object({ type: z.literal('doc'), content: z.array(nodeSchema).optional() })
  .transform((doc) => sanitizeRichText(doc));

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Allows `http`, `https`, `mailto`, `tel` and relative URLs.
 * Browsers ignore tabs, new lines and leading control characters in a scheme,
 * so the check removes them first: `java\tscript:` is `javascript:`.
 */
export function isSafeUrl(value: string): boolean {
  if (typeof value !== 'string') return false;
  // oxlint-disable-next-line no-control-regex
  const compact = value.replace(/[\u0000- \u007f-\u009f]/g, '');
  if (!compact) return false;
  if (compact.startsWith('//') || compact.startsWith('\\') || compact.includes('\\')) return false;
  const scheme = SCHEME_PATTERN.exec(compact);
  if (!scheme) return true;
  return ALLOWED_SCHEMES.has(`${scheme[1].toLowerCase()}:`);
}

export const ALLOWED_NODES = new Set([
  'doc',
  'paragraph',
  'heading',
  'text',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'hardBreak',
  'horizontalRule',
  'codeBlock',
]);
export const ALLOWED_MARKS = new Set(['bold', 'italic', 'strike', 'code', 'underline', 'link']);
const HEADING_LEVELS = new Set([2, 3, 4]);

function sanitizeMarks(marks: RichTextMark[] | undefined): RichTextMark[] | undefined {
  if (!marks) return undefined;
  const result: RichTextMark[] = [];
  for (const mark of marks) {
    if (!ALLOWED_MARKS.has(mark.type)) continue;
    if (mark.type === 'link') {
      const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href.trim() : '';
      if (!isSafeUrl(href)) continue;
      result.push({ type: 'link', attrs: { href } });
      continue;
    }
    result.push({ type: mark.type });
  }
  return result.length ? result : undefined;
}

function sanitizeNode(node: RichTextNode): RichTextNode | null {
  if (!ALLOWED_NODES.has(node.type) || node.type === 'doc') return null;
  if (node.type === 'text') {
    if (typeof node.text !== 'string' || node.text === '') return null;
    const marks = sanitizeMarks(node.marks);
    return marks ? { type: 'text', text: node.text, marks } : { type: 'text', text: node.text };
  }
  const result: RichTextNode = { type: node.type };
  if (node.type === 'heading') {
    const level = Number(node.attrs?.level);
    result.attrs = { level: HEADING_LEVELS.has(level) ? level : 2 };
  }
  if (node.type === 'orderedList' && typeof node.attrs?.start === 'number') {
    result.attrs = { start: Math.max(1, Math.floor(node.attrs.start)) };
  }
  if (node.content) {
    result.content = node.content.map(sanitizeNode).filter((child): child is RichTextNode => child !== null);
  }
  return result;
}

/** Keeps the allowed nodes and marks, and drops links with an unsafe URL. */
export function sanitizeRichText(doc: { type: 'doc'; content?: RichTextNode[] }): RichTextDoc {
  return {
    type: 'doc',
    content: (doc.content ?? []).map(sanitizeNode).filter((node): node is RichTextNode => node !== null),
  };
}

export function richTextToPlainText(doc: RichTextDoc | null | undefined): string {
  const parts: string[] = [];
  const walk = (node: RichTextNode) => {
    if (node.text) parts.push(node.text);
    node.content?.forEach(walk);
    if (['paragraph', 'heading', 'listItem', 'blockquote'].includes(node.type)) parts.push(' ');
  };
  doc?.content?.forEach(walk);
  return parts.join('').replace(/\s+/g, ' ').trim();
}
