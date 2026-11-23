import { RenderBlocks, usePreviewData } from 'genga/client';
import { data } from 'react-router';
import { gengaConfig, type PostData } from '../genga.config';
import { documentData, getGenga } from '../.server/genga';
import type { Route } from './+types/post';

export async function loader({ request, params }: Route.LoaderArgs) {
  const genga = getGenga();
  if (!genga) throw data(null, { status: 404 });
  await genga.ready();
  return documentData(await genga.published.loadForRoute<PostData>(request, 'posts', params.slug));
}

export function headers({ loaderHeaders, errorHeaders }: Route.HeadersArgs) {
  return errorHeaders ?? loaderHeaders;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  const { title, excerpt } = loaderData.doc.data;
  return [{ title }, ...(excerpt ? [{ name: 'description', content: excerpt }] : [])];
}

export default function Post({ loaderData }: Route.ComponentProps) {
  const { data: post } = usePreviewData(loaderData.doc, loaderData.preview);
  return (
    <article className="stack">
      <header>
        {post.publishedDate && <time dateTime={post.publishedDate}>{post.publishedDate}</time>}
        <h1>{post.title}</h1>
        {post.excerpt && <p className="lead">{post.excerpt}</p>}
      </header>
      {post.cover && (
        <img
          className="cover"
          src={post.cover.url}
          alt={post.cover.alt}
          width={post.cover.width ?? undefined}
          height={post.cover.height ?? undefined}
        />
      )}
      <RenderBlocks blocks={post.body} registry={gengaConfig.blocks} preview={loaderData.preview} />
      {post.tags.length > 0 && <p className="tags">{post.tags.join(' · ')}</p>}
    </article>
  );
}
