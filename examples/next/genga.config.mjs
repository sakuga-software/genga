// The config of the site and of the Genga server: the server image loads this file
// (GENGA_CONFIG), and the site reads its paths and its field types.
import { blocks, date, defineConfig, media, richText, slug, tags, text, textarea, url } from 'genga';

const siteUrl = (process.env.GENGA_SITE_URL ?? 'http://localhost:3100').replace(/\/+$/, '');

/**
 * The preview entry route of the site turns Draft Mode on, then opens the page.
 * @param {import('genga').PreviewUrlInput} doc
 */
const previewUrl = ({ path }) => `${siteUrl}/api/genga/preview?path=${encodeURIComponent(path)}`;

export const pageFields = {
  title: text({ label: 'Title', required: true, maxLength: 120 }),
  slug: slug({ label: 'Slug', from: 'title', required: true }),
  description: textarea({ label: 'Description', description: 'Shown by search engines.', maxLength: 300 }),
  body: blocks({ label: 'Content' }),
};

export const postFields = {
  title: text({ label: 'Title', required: true, maxLength: 160 }),
  slug: slug({ label: 'Slug', from: 'title', required: true }),
  excerpt: textarea({ label: 'Excerpt', maxLength: 300, rows: 3 }),
  cover: media({ label: 'Cover image', accept: 'image' }),
  publishedDate: date({ label: 'Publication date', required: true }),
  tags: tags({ label: 'Tags' }),
  body: blocks({ label: 'Content' }),
};

export const heroFields = {
  title: text({ label: 'Title', required: true, maxLength: 120 }),
  text: textarea({ label: 'Text', rows: 2 }),
  image: media({ label: 'Image', accept: 'image' }),
  ctaLabel: text({ label: 'Button label' }),
  ctaUrl: url({ label: 'Button link', placeholder: 'https://… or /page' }),
};

export default defineConfig({
  collections: {
    pages: {
      label: 'Pages',
      labelSingular: 'Page',
      titleField: 'title',
      path: (/** @type {string} */ value) => `/${value}`,
      previewUrl,
      fields: pageFields,
    },
    posts: {
      label: 'Blog',
      labelSingular: 'Post',
      titleField: 'title',
      sortField: 'publishedDate',
      path: (/** @type {string} */ value) => `/blog/${value}`,
      previewUrl,
      fields: postFields,
    },
  },
  blocks: [
    {
      type: 'hero',
      label: 'Hero',
      description: 'A large title, a short text, an image and a button.',
      fields: heroFields,
    },
    {
      type: 'rich-text',
      label: 'Text',
      description: 'Headings, paragraphs, lists and links.',
      fields: { content: richText({ label: 'Content', required: true }) },
    },
    {
      type: 'image',
      label: 'Image',
      fields: {
        image: media({ label: 'Image', required: true, accept: 'image' }),
        caption: text({ label: 'Caption' }),
      },
    },
    {
      type: 'quote',
      label: 'Quote',
      fields: {
        quote: textarea({ label: 'Quote', required: true, rows: 3 }),
        author: text({ label: 'Author' }),
      },
    },
  ],
});
