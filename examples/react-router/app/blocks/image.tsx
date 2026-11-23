import { defineBlock, media, text } from 'genga';

export const imageBlock = defineBlock({
  type: 'image',
  label: 'Image',
  fields: {
    image: media({ label: 'Image', required: true, accept: 'image' }),
    caption: text({ label: 'Caption' }),
  },
  component: ({ image, caption }) => {
    if (!image) return null;
    const srcSet = image.sizes.map((size) => `${size.url} ${size.width}w`).join(', ');
    return (
      <figure className="block image">
        <img
          src={image.url}
          srcSet={srcSet || undefined}
          sizes={srcSet ? '(min-width: 48rem) 48rem, 100vw' : undefined}
          alt={image.alt}
          width={image.width ?? undefined}
          height={image.height ?? undefined}
          loading="lazy"
        />
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
    );
  },
});
