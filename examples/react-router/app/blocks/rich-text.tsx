import { defineBlock, richText } from 'genga';
import { RichText } from 'genga/render';

export const richTextBlock = defineBlock({
  type: 'rich-text',
  label: 'Text',
  description: 'Headings, paragraphs, lists and links.',
  fields: { content: richText({ label: 'Content', required: true }) },
  component: ({ content }) => (
    <section className="block prose">
      <RichText value={content} />
    </section>
  ),
});
