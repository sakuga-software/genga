import { Link, Outlet } from 'react-router';
import '../site.css';

export default function SiteLayout() {
  return (
    <div className="site">
      <header className="site-header">
        <Link to="/" className="site-name">
          Genga example
        </Link>
        <nav aria-label="Main">
          <Link to="/">Home</Link>
          <a href="/admin">Admin</a>
        </nav>
      </header>
      <main id="content">
        <Outlet />
      </main>
    </div>
  );
}
