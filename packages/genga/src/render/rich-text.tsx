import { Fragment, type ReactNode } from 'react';
import { isSafeUrl, sanitizeRichText, type RichTextDoc, type RichTextMark, type RichTextNode } from '../rich-text';

function isExternal(href: string) {
  return /^https?:\/\//i.test(href);
}

function renderMarks(text: ReactNode, marks: RichTextMark[] | undefined): ReactNode {
  let node = text;
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':
        node = <strong>{node}</strong>;
        break;
      case 'italic':
        node = <em>{node}</em>;
        break;
      case 'strike':
        node = <s>{node}</s>;
        break;
      case 'underline':
        node = <u>{node}</u>;
        break;
      case 'code':
        node = <code>{node}</code>;
        break;
      case 'link': {
        const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
        if (!isSafeUrl(href)) break;
        node = isExternal(href) ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {node}
          </a>
        ) : (
          <a href={href}>{node}</a>
        );
        break;
      }
    }
  }
  return node;
}

function renderChildren(nodes: RichTextNode[] | undefined): ReactNode {
  return nodes?.map((child, index) => <Fragment key={index}>{renderNode(child)}</Fragment>);
}

function renderNode(node: RichTextNode): ReactNode {
  switch (node.type) {
    case 'text':
      return renderMarks(node.text ?? '', node.marks);
    case 'paragraph':
      return <p>{renderChildren(node.content)}</p>;
    case 'heading': {
      const level = node.attrs?.level;
      if (level === 3) return <h3>{renderChildren(node.content)}</h3>;
      if (level === 4) return <h4>{renderChildren(node.content)}</h4>;
      return <h2>{renderChildren(node.content)}</h2>;
    }
    case 'bulletList':
      return <ul>{renderChildren(node.content)}</ul>;
    case 'orderedList':
      return (
        <ol start={typeof node.attrs?.start === 'number' ? node.attrs.start : undefined}>
          {renderChildren(node.content)}
        </ol>
      );
    case 'listItem':
      return <li>{renderChildren(node.content)}</li>;
    case 'blockquote':
      return <blockquote>{renderChildren(node.content)}</blockquote>;
    case 'codeBlock':
      return (
        <pre>
          <code>{renderChildren(node.content)}</code>
        </pre>
      );
    case 'hardBreak':
      return <br />;
    case 'horizontalRule':
      return <hr />;
    default:
      return null;
  }
}

/**
 * Renders TipTap JSON on the server and in the browser, without `dangerouslySetInnerHTML`.
 * It sanitizes again at render time, so data written before a rule change stays safe.
 */
export function RichText({ value, className }: { value: RichTextDoc | null | undefined; className?: string }) {
  if (!value || value.type !== 'doc') return null;
  const doc = sanitizeRichText(value);
  if (!doc.content?.length) return null;
  return <div className={className}>{renderChildren(doc.content)}</div>;
}
