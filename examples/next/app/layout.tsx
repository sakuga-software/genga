import { GengaPreviewBridge } from '@genga-cms/next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { genga } from '@/lib/genga';
import './site.css';

export const metadata = { title: 'Genga example' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="site">
          <header className="site-header">
            <Link href="/" className="site-name">
              Genga example
            </Link>
            <nav aria-label="Main">
              <Link href="/">Home</Link>
              <a href={`${genga.adminOrigin}/admin`}>Admin</a>
            </nav>
          </header>
          <main id="content">{children}</main>
        </div>
        <GengaPreviewBridge source={genga} />
      </body>
    </html>
  );
}
