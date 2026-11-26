import { richTextToHtml, type RichTextDoc } from 'genga';

export type RichTextProps = { value: RichTextDoc | null | undefined; className?: string };

/**
 * Renders a rich text field in a Server or a Client Component. It builds the HTML from the
 * TipTap JSON with the allowlist renderer of Genga, and ignores the `html` that came with it.
 */
export function RichText({ value, className }: RichTextProps) {
  const html = richTextToHtml(value);
  return html ? <div className={className} dangerouslySetInnerHTML={{ __html: html }} /> : null;
}
