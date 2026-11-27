'use client';

import { usePreviewData } from '@genga-cms/next/client';
import type { PublicDocument } from 'genga/remote';
import type { PostData } from '@/lib/types';

type HeaderData = Pick<PostData, 'title' | 'excerpt' | 'publishedDate'>;

/** A Client Component: in the preview, the title follows each keystroke of the editor. */
export function PostHeader({ doc, preview }: { doc: PublicDocument<HeaderData>; preview: boolean }) {
  const { data: post } = usePreviewData(doc, preview);
  return (
    <header>
      {post.publishedDate && <time dateTime={post.publishedDate}>{post.publishedDate}</time>}
      <h1>{post.title}</h1>
      {post.excerpt && <p className="lead">{post.excerpt}</p>}
    </header>
  );
}
