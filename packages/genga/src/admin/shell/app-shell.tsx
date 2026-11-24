import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Avatar, Button, Chip, Drawer, Kbd, Toast, Tooltip } from '@heroui/react';
import {
  ExternalLink,
  FileText,
  Image,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Users,
} from 'lucide-react';
import { RouterProvider } from 'react-aria-components';
import { Link, useHref, useLocation, useNavigate } from 'react-router';
import { ROLE_LABELS } from '../../access';
import type { AppLayoutData } from '../../types';
import { CommandPalette } from './command-palette';
import { adminPath, setAdminPath } from '../../client/admin-path';

const AdminLayoutContext = createContext<AppLayoutData | null>(null);
const COLLAPSED_KEY = 'genga:sidebar-collapsed';
const SIDEBAR_ID = 'genga-sidebar';

/** The signed-in user and the collections, for any page inside the shell. */
export function useAdminLayout(): AppLayoutData | null {
  return useContext(AdminLayoutContext);
}

export type AppShellProps = {
  data: AppLayoutData;
  children: ReactNode;
};

type NavItem = { href: string; label: string; icon: typeof FileText };
type NavGroup = { label: string | null; items: NavItem[] };

function initials(name: string, email: string) {
  const source = name.trim() || email;
  return source
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function navGroups(data: AppLayoutData): NavGroup[] {
  const groups: NavGroup[] = [
    { label: null, items: [{ href: adminPath(), label: 'Tableau de bord', icon: LayoutDashboard }] },
    {
      label: 'Contenu',
      items: [
        ...data.collections.map((collection) => ({
          href: `${adminPath()}/collections/${collection.name}`,
          label: collection.label,
          icon: FileText,
        })),
        { href: adminPath('/media'), label: 'Médias', icon: Image },
      ],
    },
  ];
  const settings: NavItem[] = [];
  if (data.canManageUsers) settings.push({ href: adminPath('/users'), label: 'Utilisateurs', icon: Users });
  settings.push({ href: adminPath('/tokens'), label: 'Jetons d’accès', icon: KeyRound });
  groups.push({ label: 'Réglages', items: settings });
  return groups;
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function storeCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Blocked storage: the state lasts until the page closes.
  }
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <Link
      to={adminPath()}
      className="flex items-center gap-2 rounded-lg px-2 py-1"
      aria-label={collapsed ? 'Genga, tableau de bord' : undefined}
    >
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--genga-coral)] text-[#050505] genga-display font-bold"
      >
        原
      </span>
      {!collapsed && <span className="genga-display text-lg font-semibold">Genga</span>}
    </Link>
  );
}

function SidebarNav({
  groups,
  isCurrent,
  collapsed,
  onNavigate,
}: {
  groups: NavGroup[];
  isCurrent: (href: string) => boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Navigation principale" className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-2">
      {groups.map((group) => (
        <div key={group.label ?? 'main'} className="flex flex-col gap-1">
          {group.label &&
            (collapsed ? (
              <span aria-hidden className="mx-2 my-1 h-px bg-[var(--separator)]" />
            ) : (
              <p className="px-2 pb-1 text-xs font-medium tracking-wide text-[var(--muted)] uppercase">{group.label}</p>
            ))}
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const current = isCurrent(item.href);
              const Icon = item.icon;
              const link = (
                <Link
                  to={item.href}
                  onClick={onNavigate}
                  aria-current={current ? 'page' : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  className={`flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition-colors ${
                    collapsed ? 'justify-center' : ''
                  } ${
                    current
                      ? 'bg-[var(--surface-tertiary)] font-medium text-[var(--foreground)]'
                      : 'text-[var(--muted)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]'
                  }`}
                >
                  <Icon aria-hidden className={`size-4 shrink-0 ${current ? 'text-[var(--accent)]' : ''}`} />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              );
              return (
                <li key={item.href}>
                  {collapsed ? (
                    <Tooltip delay={300}>
                      <Tooltip.Trigger>{link}</Tooltip.Trigger>
                      <Tooltip.Content placement="right">{item.label}</Tooltip.Content>
                    </Tooltip>
                  ) : (
                    link
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function UserFooter({ data, collapsed }: { data: AppLayoutData; collapsed: boolean }) {
  const name = data.user.name || data.user.email;
  return (
    <div
      className={`flex items-center gap-3 border-t border-[var(--separator)] px-3 py-3 ${collapsed ? 'flex-col' : ''}`}
    >
      <Avatar size="sm" aria-label={name}>
        <Avatar.Fallback>{initials(data.user.name, data.user.email)}</Avatar.Fallback>
      </Avatar>
      {!collapsed && (
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-xs text-[var(--muted)]">{ROLE_LABELS[data.user.role]}</p>
        </div>
      )}
      <form method="post" action={adminPath('/api/logout')}>
        <Tooltip delay={300}>
          <Button type="submit" isIconOnly size="sm" variant="ghost" aria-label="Se déconnecter">
            <LogOut aria-hidden className="size-4" />
          </Button>
          <Tooltip.Content>Se déconnecter</Tooltip.Content>
        </Tooltip>
      </form>
    </div>
  );
}

/**
 * The admin frame: a sidebar that collapses (⌘B or Ctrl+B), a top bar and the content.
 * Below the `md` breakpoint, the sidebar opens as a drawer.
 */
export function AppShell({ data, children }: AppShellProps) {
  setAdminPath(data.adminPath);
  const navigate = useNavigate();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const path = location.pathname.replace(/\/+$/, '') || adminPath();
  const groups = navGroups(data);

  useEffect(() => setCollapsed(readCollapsed()), []);

  function toggleCollapsed() {
    setCollapsed((value) => {
      storeCollapsed(!value);
      return !value;
    });
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (key === 'b') {
        event.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const isCurrent = (href: string) => (href === adminPath() ? path === adminPath() : path.startsWith(href));

  return (
    <RouterProvider navigate={navigate} useHref={useHref}>
      <AdminLayoutContext.Provider value={data}>
        <a href="#genga-main" className="genga-skip-link">
          Aller au contenu
        </a>
        <div className="flex h-dvh overflow-hidden">
          <aside
            id={SIDEBAR_ID}
            aria-label="Menu latéral"
            className={`hidden shrink-0 flex-col border-r border-[var(--separator)] bg-[var(--surface)] transition-[width] duration-200 md:flex ${
              collapsed ? 'w-16' : 'w-64'
            }`}
          >
            <div className={`flex h-16 items-center px-3 ${collapsed ? 'justify-center' : ''}`}>
              <Brand collapsed={collapsed} />
            </div>
            <SidebarNav groups={groups} isCurrent={isCurrent} collapsed={collapsed} />
            <UserFooter data={data} collapsed={collapsed} />
          </aside>

          <Drawer.Backdrop isOpen={drawerOpen} onOpenChange={setDrawerOpen}>
            <Drawer.Content placement="left" className="w-72 max-w-[85vw]">
              <Drawer.Dialog aria-label="Menu" className="flex h-full flex-col p-0">
                <div className="flex h-16 items-center justify-between px-3">
                  <Brand collapsed={false} />
                  <Drawer.CloseTrigger aria-label="Fermer le menu" />
                </div>
                <SidebarNav
                  groups={groups}
                  isCurrent={isCurrent}
                  collapsed={false}
                  onNavigate={() => setDrawerOpen(false)}
                />
                <UserFooter data={data} collapsed={false} />
              </Drawer.Dialog>
            </Drawer.Content>
          </Drawer.Backdrop>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-16 shrink-0 items-center gap-2 border-b border-[var(--separator)] px-3 md:px-4">
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                className="md:hidden"
                aria-label="Ouvrir le menu"
                onPress={() => setDrawerOpen(true)}
              >
                <MenuIcon aria-hidden className="size-4" />
              </Button>
              <Tooltip delay={300}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="hidden md:inline-flex"
                  aria-label="Menu latéral"
                  aria-controls={SIDEBAR_ID}
                  aria-expanded={!collapsed}
                  aria-keyshortcuts="Meta+B Control+B"
                  onPress={toggleCollapsed}
                >
                  {collapsed ? (
                    <PanelLeftOpen aria-hidden className="size-4" />
                  ) : (
                    <PanelLeftClose aria-hidden className="size-4" />
                  )}
                </Button>
                <Tooltip.Content>{collapsed ? 'Déplier le menu' : 'Replier le menu'} (⌘B)</Tooltip.Content>
              </Tooltip>
              <span className="flex-1" />
              <Button
                variant="secondary"
                size="sm"
                onPress={() => setPaletteOpen(true)}
                aria-keyshortcuts="Meta+K Control+K"
              >
                <Search aria-hidden className="size-4" />
                <span>Rechercher</span>
                <Kbd className="ml-2 hidden sm:inline-flex">⌘K</Kbd>
              </Button>
              {data.siteLink && (
                <a
                  href={data.siteLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  <span className="hidden sm:inline">Voir le site</span>
                  <ExternalLink aria-hidden className="size-3.5" />
                  <span className="sr-only">
                    <span className="sm:hidden">Voir le site</span> (nouvel onglet)
                  </span>
                </a>
              )}
              {data.user.role === 'author' && (
                <Chip size="sm" variant="soft" color="warning" className="ml-1">
                  Mode auteur
                </Chip>
              )}
            </header>
            <main id="genga-main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
              {children}
            </main>
          </div>
        </div>
        <CommandPalette
          isOpen={paletteOpen}
          onOpenChange={setPaletteOpen}
          collections={data.collections}
          canManageUsers={data.canManageUsers}
        />
        <Toast.Provider placement="bottom end" />
      </AdminLayoutContext.Provider>
    </RouterProvider>
  );
}
