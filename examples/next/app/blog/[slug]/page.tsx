import { Blocks, loadPage } from '@genga-cms/next';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { blocks } from '@/blocks';
import { PostHeader } from '@/components/post-header';
import { genga } from '@/lib/genga';
import type { PostData } from '@/lib/types';

type Props = { params: Promise<{ slug: string }> };

/** No post at build time: each post renders at its first request, then stays cached until a publish. */
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await loadPage<PostData>(genga, 'posts', (await params).slug);
  if (page.kind !== 'document') return {};
  return {
    title: page.doc.data.title,
    description: page.doc.data.excerpt || undefined,
    robots: page.preview ? { index: false } : undefined,
  };
}

export default async function Post({ params }: Props) {
  const page = await loadPage<PostData>(genga, 'posts', (await params).slug);
  if (page.kind === 'redirect') permanentRedirect(page.location);
  if (page.kind === 'not-found') notFound();
  const { doc, preview } = page;
  return (
    <article className="stack">
      <PostHeader
        doc={{
          ...doc,
          data: { title: doc.data.title, excerpt: doc.data.excerpt, publishedDate: doc.data.publishedDate },
        }}
        preview={preview}
      />
      {doc.data.cover && (
        <img
          className="cover"
          src={doc.data.cover.url}
          alt={doc.data.cover.alt}
          width={doc.data.cover.width ?? undefined}
          height={doc.data.cover.height ?? undefined}
        />
      )}
      <Blocks blocks={doc.data.body} registry={blocks} preview={preview} />
      {doc.data.tags.length > 0 && <p className="tags">{doc.data.tags.join(' · ')}</p>}
    </article>
  );
}
