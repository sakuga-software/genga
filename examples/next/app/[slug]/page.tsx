import { Blocks, loadPage } from '@genga-cms/next';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { blocks } from '@/blocks';
import { genga } from '@/lib/genga';
import type { PageData } from '@/lib/types';

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await loadPage<PageData>(genga, 'pages', (await params).slug);
  if (page.kind !== 'document') return {};
  return {
    title: page.doc.data.title,
    description: page.doc.data.description || undefined,
    robots: page.preview ? { index: false } : undefined,
  };
}

export default async function Page({ params }: Props) {
  const page = await loadPage<PageData>(genga, 'pages', (await params).slug);
  if (page.kind === 'redirect') permanentRedirect(page.location);
  if (page.kind === 'not-found') notFound();
  const { doc, preview } = page;
  return (
    <article className="stack">
      <h1>{doc.data.title}</h1>
      <Blocks blocks={doc.data.body} registry={blocks} preview={preview} />
    </article>
  );
}
