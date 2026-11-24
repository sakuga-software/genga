import { useEffect, useState, type ReactNode } from 'react';
import { Header, Kbd, Menu, MenuItem, MenuSection, Modal, SearchField } from '@heroui/react';
import { FilePlus, FileText, Image, KeyRound, LayoutDashboard, Users } from 'lucide-react';
import { Autocomplete, useFilter, type Key } from 'react-aria-components';
import { useNavigate } from 'react-router';
import { apiRequest } from '../../client/api';
import type { CollectionNav, DocumentSummary } from '../../types';
import { adminPath } from '../../client/admin-path';

type CommandPaletteProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  collections: CollectionNav[];
  canManageUsers: boolean;
};

type Command = { id: string; label: string; icon: ReactNode; detail?: string };

const ICON = 'size-4 shrink-0 text-[var(--muted)]';

function CommandItem({ command }: { command: Command }) {
  return (
    <MenuItem id={command.id} textValue={command.label} className="flex items-center gap-3">
      {command.icon}
      <span className="min-w-0 flex-1 truncate">{command.label}</span>
      {command.detail && <span className="text-xs text-[var(--muted)]">{command.detail}</span>}
    </MenuItem>
  );
}

function CommandSection({ title, commands }: { title: string; commands: Command[] }) {
  if (commands.length === 0) return null;
  return (
    <MenuSection>
      <Header className="px-2 pt-3 pb-1 text-xs font-medium tracking-wide text-[var(--muted)] uppercase">
        {title}
      </Header>
      {commands.map((command) => (
        <CommandItem key={command.id} command={command} />
      ))}
    </MenuSection>
  );
}

/**
 * ⌘K palette: jump to a page, a collection or a document, or create a document.
 * A search field filters a menu. The arrow keys move the virtual focus, and Enter runs the command.
 */
export function CommandPalette({ isOpen, onOpenChange, collections, canManageUsers }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { contains } = useFilter({ sensitivity: 'base' });
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    Promise.all(
      collections.map((collection) =>
        apiRequest<{ documents: DocumentSummary[] }>(`documents?collection=${encodeURIComponent(collection.name)}`)
          .then((result) => result.documents)
          .catch(() => []),
      ),
    ).then((lists) => {
      if (!cancelled) setDocuments(lists.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, collections]);

  const labelOf = (name: string) => collections.find((collection) => collection.name === name)?.labelSingular ?? name;

  const pages: Command[] = [
    { id: `go:${adminPath()}`, label: 'Tableau de bord', icon: <LayoutDashboard aria-hidden className={ICON} /> },
    ...collections.map((collection) => ({
      id: `go:${adminPath()}/collections/${collection.name}`,
      label: collection.label,
      icon: <FileText aria-hidden className={ICON} />,
    })),
    { id: `go:${adminPath()}/media`, label: 'Médias', icon: <Image aria-hidden className={ICON} /> },
    ...(canManageUsers
      ? [{ id: `go:${adminPath()}/users`, label: 'Utilisateurs', icon: <Users aria-hidden className={ICON} /> }]
      : []),
    { id: `go:${adminPath()}/tokens`, label: 'Jetons d’accès', icon: <KeyRound aria-hidden className={ICON} /> },
  ];
  const creates: Command[] = collections
    .filter((collection) => collection.canCreate)
    .map((collection) => ({
      id: `new:${collection.name}`,
      label: `Nouveau : ${collection.labelSingular.toLowerCase()}`,
      icon: <FilePlus aria-hidden className={ICON} />,
    }));
  const docs: Command[] = documents.map((doc) => ({
    id: `go:${adminPath()}/collections/${doc.collection}/${doc.id}`,
    label: doc.title,
    detail: labelOf(doc.collection),
    icon: <FileText aria-hidden className={ICON} />,
  }));

  async function createIn(collection: string) {
    const created = await apiRequest<{ id: string }>('documents', { method: 'POST', json: { collection } });
    navigate(`${adminPath()}/collections/${collection}/${created.id}`);
  }

  function onAction(key: Key) {
    const value = String(key);
    onOpenChange(false);
    if (value.startsWith('go:')) navigate(value.slice(3));
    if (value.startsWith('new:')) void createIn(value.slice(4));
  }

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container size="md" placement="top" className="mt-[12vh]">
        <Modal.Dialog aria-label="Palette de commandes" className="overflow-hidden p-0">
          <Autocomplete filter={contains}>
            <div className="border-b border-[var(--separator)] p-3">
              <SearchField autoFocus aria-label="Rechercher une page ou un document" fullWidth>
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder="Aller à… ou chercher un document" />
                  <SearchField.ClearButton aria-label="Effacer" />
                </SearchField.Group>
              </SearchField>
            </div>
            <Menu
              aria-label="Résultats"
              onAction={onAction}
              className="max-h-[50vh] overflow-y-auto p-2"
              renderEmptyState={() => <p className="p-6 text-center text-sm text-[var(--muted)]">Aucun résultat.</p>}
            >
              <CommandSection title="Pages" commands={pages} />
              <CommandSection title="Créer" commands={creates} />
              <CommandSection title="Documents" commands={docs} />
            </Menu>
          </Autocomplete>
          <p className="flex items-center gap-3 border-t border-[var(--separator)] px-4 py-2 text-xs text-[var(--muted)]">
            <span>
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> pour choisir
            </span>
            <span>
              <Kbd>Entrée</Kbd> pour ouvrir
            </span>
            <span>
              <Kbd>Échap</Kbd> pour fermer
            </span>
          </p>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
