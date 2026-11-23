# Blocks

A block is a React component of your site with a field schema. A `blocks` field holds a list
of blocks, and the editor adds, moves, duplicates and deletes them.

```tsx
import { defineBlock, media, text } from 'genga';

export const heroBlock = defineBlock({
  type: 'hero',
  label: 'Hero',
  description: 'A large title and an image.',
  fields: {
    title: text({ label: 'Title', required: true }),
    image: media({ label: 'Image', accept: 'image' }),
  },
  component: ({ title, image }) => (
    <section>
      <h2>{title}</h2>
      {image && <img src={image.url} alt={image.alt} />}
    </section>
  ),
});
```

- The props of the component are the field values, plus `_id` and `_type`.
- A `media` value reaches the component as a `MediaObject` (`url`, `alt`, `width`, `height`,
  `sizes`), because `populate` resolves the media ids before the render.
- Each block gets a stable `_id`. Use it as a key, never the index.

## Render the blocks

```tsx
import { RenderBlocks } from 'genga/client';
import { gengaConfig } from '~/genga.config';

<RenderBlocks blocks={data.body} registry={gengaConfig.blocks} preview={preview} />;
```

- Each block renders in its own error boundary. A failed block renders nothing on the public
  site, and a message in preview mode.
- The public site skips unknown block types.
- With `preview`, each block root gets `data-genga-block-id`, so a click in the preview
  selects the block in the editor.

## Rich text

A `richText` field stores TipTap JSON. Render it with `RichText`:

```tsx
import { RichText } from 'genga/client';

<RichText value={content} className="prose" />;
```

The renderer builds React elements from an allowlist of nodes (`paragraph`, `heading` 2 to 4,
lists, `blockquote`, `hardBreak`, `horizontalRule`, `codeBlock`) and marks (`bold`, `italic`,
`strike`, `code`, `underline`, `link`). It never uses `dangerouslySetInnerHTML`. Links accept
only `http`, `https`, `mailto`, `tel` and relative URLs; external links get
`rel="noopener noreferrer"`. The server applies the same sanitizer at write time.
