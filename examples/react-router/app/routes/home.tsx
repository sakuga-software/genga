import { Link } from 'react-router';
import type { PageData, PostData } from '../genga.config';
import { getGenga } from '../.server/genga';
import type { Route } from './+types/home';

export async function loader() {
  const genga = getGenga();
  if (!genga) return { enabled: false, pages: [], posts: [] };
  await genga.ready();
  const [pages, posts] = await Promise.all([
    genga.published.list<PageData>('pages'),
    genga.published.list<PostData>('posts', { limit: 10 }),
  ]);
  return {
    enabled: true,
    pages: pages.map(({ data }) => ({ slug: data.slug, title: data.title })),
    posts: posts.map(({ data }) => ({ slug: data.slug, title: data.title, excerpt: data.excerpt })),
  };
}

export const meta = () => [{ title: 'Genga example' }];

export default function Home({ loaderData }: Route.ComponentProps) {
  const { enabled, pages, posts } = loaderData;
  return (
    <div className="stack">
      <h1>Genga example</h1>
      {!enabled && (
        <p className="note">
          The CMS is off. Set <code>DATABASE_URL</code> and restart the server.
        </p>
      )}
      {enabled && pages.length + posts.length === 0 && (
        <p className="note">
          Nothing is published yet. Open <a href="/admin">the admin</a> to write a page or a post.
        </p>
      )}
      {pages.length > 0 && (
        <section aria-labelledby="pages-heading">
          <h2 id="pages-heading">Pages</h2>
          <ul>
            {pages.map((page) => (
              <li key={page.slug}>
                <Link to={`/${page.slug}`}>{page.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {posts.length > 0 && (
        <section aria-labelledby="posts-heading">
          <h2 id="posts-heading">Blog</h2>
          <ul className="posts">
            {posts.map((post) => (
              <li key={post.slug}>
                <Link to={`/blog/${post.slug}`}>{post.title}</Link>
                {post.excerpt && <p>{post.excerpt}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
