import Link from 'next/link';
import { connection } from 'next/server';
import { genga } from '@/lib/genga';
import type { PageData, PostData } from '@/lib/types';

export default async function Home() {
  // The build has no Genga server: read the lists at request time. The reads stay cached by tag.
  await connection();
  const [pages, posts] = await Promise.all([
    genga.listDocuments<PageData>('pages', { limit: 50 }),
    genga.listDocuments<PostData>('posts', { limit: 10 }),
  ]);
  return (
    <div className="stack">
      <h1>Genga example</h1>
      {pages.documents.length + posts.documents.length === 0 && (
        <p className="note">Nothing is published yet. Open the admin to write a page or a post.</p>
      )}
      {pages.documents.length > 0 && (
        <section aria-labelledby="pages-heading">
          <h2 id="pages-heading">Pages</h2>
          <ul>
            {pages.documents.map((page) => (
              <li key={page.id}>
                <Link href={page.path}>{page.data.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {posts.documents.length > 0 && (
        <section aria-labelledby="posts-heading">
          <h2 id="posts-heading">Blog</h2>
          <ul className="posts">
            {posts.documents.map((post) => (
              <li key={post.id}>
                <Link href={post.path}>{post.data.title}</Link>
                {post.data.excerpt && <p>{post.data.excerpt}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
