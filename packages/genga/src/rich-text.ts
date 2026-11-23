import { z } from 'zod';
import { sanitizeRichText, type RichTextNode } from './rich-text-sanitize';

export * from './rich-text-sanitize';

const nodeSchema: z.ZodType<RichTextNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(nodeSchema).optional(),
    marks: z.array(z.object({ type: z.string(), attrs: z.record(z.string(), z.unknown()).optional() })).optional(),
    text: z.string().optional(),
  }),
);

export const richTextDocSchema = z
  .object({ type: z.literal('doc'), content: z.array(nodeSchema).optional() })
  .transform((doc) => sanitizeRichText(doc));
