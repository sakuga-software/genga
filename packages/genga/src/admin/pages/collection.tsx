import { useEffect, useState } from 'react';
import { Button, Label, ListBox, SearchField, Select, Table } from '@heroui/react';
import { FileText, Plus } from 'lucide-react';
import { Link, useLoaderData, useNavigate, useSearchParams } from 'react-router';
import { ApiError, apiRequest } from '../../client/api';
import type { CollectionPageData } from '../../types';
import { formatDateTime } from '../components/format';
import { PageHeader } from '../components/page-header';
import { STATUS_LABELS, StatusChip } from '../components/status-chip';
import { EmptyState } from '../ui/empty-state';
import { adminPath } from '../../client/admin-path';

export function CollectionPage() {
  const { collection, documents, search, status } = useLoaderData() as CollectionPageData;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState(search);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setQuery(search), [search]);

  useEffect(() => {
    if (query === search) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      if (query) next.set('q', query);
      else next.delete('q');
      setParams(next, { replace: true });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, search, params, setParams]);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const created = await apiRequest<{ id: string }>('documents', {
        method: 'POST',
        json: { collection: collection.name },
      });
      navigate(`${adminPath()}/collections/${collection.name}/${created.id}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Création impossible.');
      setCreating(false);
    }
  }

  return (
    <div className="p-6 md:p-10">
      <PageHeader
        title={collection.label}
        description={`${documents.length} document${documents.length > 1 ? 's' : ''}`}
        actions={
          collection.canCreate && (
            <Button variant="primary" onPress={create} isPending={creating}>
              <Plus aria-hidden className="size-4" /> Nouveau : {collection.labelSingular.toLowerCase()}
            </Button>
          )
        }
      />
      {error && (
        <p role="alert" className="mb-4 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      <div role="search" className="mb-6 flex flex-wrap items-end gap-3">
        <SearchField value={query} onChange={setQuery} className="w-full max-w-sm">
          <Label>Rechercher</Label>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="Titre ou slug" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <Select
          className="w-48"
          value={status}
          onChange={(key) => {
            const next = new URLSearchParams(params);
            if (key && key !== 'all') next.set('status', String(key));
            else next.delete('status');
            setParams(next, { replace: true });
          }}
        >
          <Label>Statut</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {(['all', 'draft', 'published', 'changed'] as const).map((key) => (
                <ListBox.Item key={key} id={key} textValue={key === 'all' ? 'Tous' : STATUS_LABELS[key]}>
                  {key === 'all' ? 'Tous' : STATUS_LABELS[key]}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
      {documents.length === 0 ? (
        <EmptyState
          icon={<FileText className="size-5" />}
          title={search || status !== 'all' ? 'Aucun résultat' : 'Aucun document'}
          description={
            search || status !== 'all'
              ? 'Modifiez la recherche ou le filtre.'
              : 'Créez le premier document de cette collection.'
          }
        />
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label={collection.label} className="min-w-[640px]">
              <Table.Header>
                <Table.Column isRowHeader>Titre</Table.Column>
                <Table.Column>Statut</Table.Column>
                <Table.Column>Auteur</Table.Column>
                <Table.Column>Modifié</Table.Column>
              </Table.Header>
              <Table.Body>
                {documents.map((doc) => (
                  <Table.Row key={doc.id} id={doc.id}>
                    <Table.Cell>
                      <Link
                        to={`${adminPath()}/collections/${collection.name}/${doc.id}`}
                        className="font-medium hover:text-[var(--accent)]"
                      >
                        {doc.title}
                      </Link>
                      <span className="genga-mono block text-xs text-[var(--muted)]">/{doc.slug}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <StatusChip status={doc.status} />
                    </Table.Cell>
                    <Table.Cell>{doc.authorName || '—'}</Table.Cell>
                    <Table.Cell>{formatDateTime(doc.updatedAt)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}
    </div>
  );
}
