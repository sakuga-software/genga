'use client';

export function Quote({ quote, author }: { quote: string; author: string }) {
  return (
    <figure className="block quote">
      <blockquote>
        <p>{quote}</p>
      </blockquote>
      {author && <figcaption>{author}</figcaption>}
    </figure>
  );
}
