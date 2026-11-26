'use client';

import type { HeroData } from '@/lib/types';

export function Hero({ title, text: body, image, ctaLabel, ctaUrl }: HeroData) {
  return (
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
  );
}
