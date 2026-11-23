import { RenderBlocks, usePreviewData } from 'genga/client';
import { data } from 'react-router';
import { gengaConfig, type PageData } from '../genga.config';
import { documentData, getGenga } from '../.server/genga';
import type { Route } from './+types/page';

export async function loader({ request, params }: Route.LoaderArgs) {
  const genga = getGenga();
  if (!genga) throw data(null, { status: 404 });
  await genga.ready();
  return documentData(await genga.published.loadForRoute<PageData>(request, 'pages', params.slug));
}

export function headers({ loaderHeaders, errorHeaders }: Route.HeadersArgs) {
  return errorHeaders ?? loaderHeaders;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  const { title, description } = loaderData.doc.data;
  return [{ title }, ...(description ? [{ name: 'description', content: description }] : [])];
}

export default function Page({ loaderData }: Route.ComponentProps) {
  const { data: page } = usePreviewData(loaderData.doc, loaderData.preview);
  return (
    <article className="stack">
      <h1>{page.title}</h1>
      <RenderBlocks blocks={page.body} registry={gengaConfig.blocks} preview={loaderData.preview} />
    </article>
  );
}
