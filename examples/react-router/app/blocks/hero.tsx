import { defineBlock, media, text, textarea, url } from 'genga';

export const heroBlock = defineBlock({
  type: 'hero',
  label: 'Hero',
  description: 'A large title, a short text, an image and a button.',
  fields: {
    title: text({ label: 'Title', required: true, maxLength: 120 }),
    text: textarea({ label: 'Text', rows: 2 }),
    image: media({ label: 'Image', accept: 'image' }),
    ctaLabel: text({ label: 'Button label' }),
    ctaUrl: url({ label: 'Button link', placeholder: 'https://… or /page' }),
  },
  component: ({ title, text: body, image, ctaLabel, ctaUrl }) => (
    <section className="block hero">
      <div>
        <h2>{title}</h2>
        {body && <p>{body}</p>}
        {ctaLabel && ctaUrl && (
          <a className="button" href={ctaUrl}>
            {ctaLabel}
          </a>
        )}
      </div>
      {image && (
        <img src={image.url} alt={image.alt} width={image.width ?? undefined} height={image.height ?? undefined} />
      )}
    </section>
  ),
});
