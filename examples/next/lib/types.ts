import type { FieldValues } from 'genga';
import type { heroFields, pageFields, postFields } from '@/genga.config.mjs';

export type PageData = FieldValues<typeof pageFields>;
export type PostData = FieldValues<typeof postFields>;
export type HeroData = FieldValues<typeof heroFields>;
