import { defineBlockComponents } from '@genga-cms/next';
import config from '@/genga.config.mjs';
import { Hero } from './hero';
import { Image } from './image';
import { Quote } from './quote';
import { RichText } from './rich-text';

/** `hero` and `quote` are Client Components: they follow each keystroke in the preview. */
export const blocks = defineBlockComponents(config, {
  hero: Hero,
  'rich-text': RichText,
  image: Image,
  quote: Quote,
});
