import { blocks, date, defineConfig, media, slug, tags, text, textarea, type FieldValues } from 'genga';
import { heroBlock } from './blocks/hero';
import { imageBlock } from './blocks/image';
import { quoteBlock } from './blocks/quote';
import { richTextBlock } from './blocks/rich-text';

const pageFields = {
  title: text({ label: 'Title', required: true, maxLength: 120 }),
  slug: slug({ label: 'Slug', from: 'title', required: true }),
  description: textarea({ label: 'Description', description: 'Shown by search engines.', maxLength: 300 }),
  body: blocks({ label: 'Content' }),
};

const postFields = {
  title: text({ label: 'Title', required: true, maxLength: 160 }),
  slug: slug({ label: 'Slug', from: 'title', required: true }),
  excerpt: textarea({ label: 'Excerpt', maxLength: 300, rows: 3 }),
  cover: media({ label: 'Cover image', accept: 'image' }),
  publishedDate: date({ label: 'Publication date', required: true }),
  tags: tags({ label: 'Tags' }),
  body: blocks({ label: 'Content' }),
};

export type PageData = FieldValues<typeof pageFields>;
export type PostData = FieldValues<typeof postFields>;

export const gengaConfig = defineConfig({
  collections: {
    pages: {
      label: 'Pages',
      labelSingular: 'Page',
      titleField: 'title',
      path: (value) => `/${value}`,
      fields: pageFields,
    },
    posts: {
      label: 'Blog',
      labelSingular: 'Post',
      titleField: 'title',
      sortField: 'publishedDate',
      path: (value) => `/blog/${value}`,
      fields: postFields,
    },
  },
  blocks: [heroBlock, richTextBlock, imageBlock, quoteBlock],
});
