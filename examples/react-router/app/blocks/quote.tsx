import { defineBlock, text, textarea } from 'genga';

export const quoteBlock = defineBlock({
  type: 'quote',
  label: 'Quote',
  fields: {
    quote: textarea({ label: 'Quote', required: true, rows: 3 }),
    author: text({ label: 'Author' }),
  },
  component: ({ quote, author }) => (
    <figure className="block quote">
      <blockquote>
        <p>{quote}</p>
      </blockquote>
      {author && <figcaption>{author}</figcaption>}
    </figure>
  ),
});
