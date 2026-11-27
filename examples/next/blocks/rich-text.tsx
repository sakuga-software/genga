import { RichText as GengaRichText } from '@genga-cms/next';
import type { RichTextDoc } from 'genga';

export function RichText({ content }: { content: RichTextDoc | null }) {
  return <GengaRichText value={content} className="block prose" />;
}
