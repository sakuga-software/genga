import 'server-only';
import { createRemoteSource } from '@genga-cms/next';
import config from '@/genga.config.mjs';

export const genga = createRemoteSource({
  url: process.env.GENGA_URL ?? 'http://localhost:3000',
  schema: config,
});
