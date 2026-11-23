import {
  isSafeUrl,
  sanitizeRichText,
  type RichTextDoc,
  type RichTextMark,
  type RichTextNode,
} from './rich-text-sanitize';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

function wrapMarks(html: string, marks: RichTextMark[] | undefined): string {
  let result = html;
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':
        result = `<strong>${result}</strong>`;
        break;
      case 'italic':
        result = `<em>${result}</em>`;
        break;
      case 'strike':
        result = `<s>${result}</s>`;
        break;
      case 'underline':
        result = `<u>${result}</u>`;
        break;
      case 'code':
        result = `<code>${result}</code>`;
        break;
      case 'link': {
        const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
        if (!isSafeUrl(href)) break;
        const external = /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
        result = `<a href="${escapeHtml(href)}"${external}>${result}</a>`;
        break;
      }
    }
  }
  return result;
}

function children(nodes: RichTextNode[] | undefined): string {
  return (nodes ?? []).map(nodeToHtml).join('');
}

function nodeToHtml(node: RichTextNode): string {
  switch (node.type) {
    case 'text':
      return wrapMarks(escapeHtml(node.text ?? ''), node.marks);
    case 'paragraph':
      return `<p>${children(node.content)}</p>`;
    case 'heading': {
      const level = node.attrs?.level === 3 || node.attrs?.level === 4 ? node.attrs.level : 2;
      return `<h${level}>${children(node.content)}</h${level}>`;
    }
    case 'bulletList':
      return `<ul>${children(node.content)}</ul>`;
    case 'orderedList': {
      const start = typeof node.attrs?.start === 'number' ? ` start="${node.attrs.start}"` : '';
      return `<ol${start}>${children(node.content)}</ol>`;
    }
    case 'listItem':
      return `<li>${children(node.content)}</li>`;
    case 'blockquote':
      return `<blockquote>${children(node.content)}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${children(node.content)}</code></pre>`;
    case 'hardBreak':
      return '<br/>';
    case 'horizontalRule':
      return '<hr/>';
    default:
      return '';
  }
}

/**
 * Renders TipTap JSON to an HTML string, for sites that do not use React.
 * It sanitizes first and uses the same allowlist and markup as `<RichText>`.
 */
export function richTextToHtml(value: RichTextDoc | null | undefined): string {
  if (!value || value.type !== 'doc') return '';
  return children(sanitizeRichText(value).content);
}
