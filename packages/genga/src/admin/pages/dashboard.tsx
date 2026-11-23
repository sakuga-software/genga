import { Button, Card } from '@heroui/react';
import { FilePen, FileText, Image, Plus } from 'lucide-react';
import { Link, useNavigate, useLoaderData } from 'react-router';
import { apiRequest } from '../../client/api';
import type { DashboardData } from '../../types';
import { useAdminLayout } from '../shell/app-shell';
import { formatDateTime } from '../components/format';
import { PageHeader } from '../components/page-header';
import { StatusChip } from '../components/status-chip';
import { EmptyState } from '../ui/empty-state';
import { KpiGroup } from '../ui/kpi';
import { adminPath } from '../../client/admin-path';

export function DashboardPage() {
  const data = useLoaderData() as DashboardData;
  const layout = useAdminLayout();
  const navigate = useNavigate();
  const collections = layout?.collections ?? [];
  const totals = Object.values(data.counts).reduce(
    (sum, count) => ({
      published: sum.published + count.published,
      changed: sum.changed + count.changed,
      draft: sum.draft + count.draft,
    }),
    { published: 0, changed: 0, draft: 0 },
  );

  async function create(collection: string) {
    const created = await apiRequest<{ id: string }>('documents', { method: 'POST', json: { collection } });
    navigate(`${adminPath()}/collections/${collection}/${created.id}`);
  }

  return (
    <div className="p-6 md:p-10">
      <PageHeader
        title={`Bonjour${layout?.user.name ? `, ${layout.user.name.split(' ')[0]}` : ''}`}
        description="Ce qui se passe sur le site."
        actions={collections
          .filter((collection) => collection.canCreate)
          .map((collection) => (
            <Button key={collection.name} variant="secondary" size="sm" onPress={() => void create(collection.name)}>
              <Plus aria-hidden className="size-4" /> {collection.labelSingular}
            </Button>
          ))}
      />

      <section className="mb-10">
        <KpiGroup
          label="Chiffres clés"
          items={[
            {
              label: 'Pages en ligne',
              value: totals.published + totals.changed,
              tone: 'success',
              icon: <FileText className="size-4" />,
            },
            {
              label: 'À publier',
              value: totals.draft + totals.changed,
              tone: 'warning',
              icon: <FilePen className="size-4" />,
            },
            { label: 'Médias', value: data.mediaCount, icon: <Image className="size-4" /> },
          ]}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section aria-labelledby="recent-heading" className="lg:col-span-2">
          <h2 id="recent-heading" className="genga-display mb-4 text-lg font-semibold">
            Modifié récemment
          </h2>
          {data.recent.length === 0 ? (
            <EmptyState size="sm" title="Rien pour l’instant" description="Créez un premier document." />
          ) : (
            <ul className="divide-y divide-[var(--separator)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              {data.recent.map((doc) => (
                <li key={doc.id}>
                  <Link
                    to={`${adminPath()}/collections/${doc.collection}/${doc.id}`}
                    className="flex items-center gap-4 px-4 py-3 hover:bg-[var(--surface-secondary)] first:rounded-t-xl last:rounded-b-xl"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{doc.title}</span>
                      <span className="block text-xs text-[var(--muted)]">
                        {collections.find((collection) => collection.name === doc.collection)?.labelSingular ??
                          doc.collection}{' '}
                        · {formatDateTime(doc.updatedAt)}
                      </span>
                    </span>
                    <StatusChip status={doc.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="collections-heading">
          <h2 id="collections-heading" className="genga-display mb-4 text-lg font-semibold">
            Collections
          </h2>
          <div className="flex flex-col gap-3">
            {collections.map((collection) => {
              const count = data.counts[collection.name] ?? { draft: 0, published: 0, changed: 0 };
              return (
                <Card key={collection.name}>
                  <Card.Header>
                    <Card.Title>
                      <Link to={`${adminPath()}/collections/${collection.name}`} className="hover:text-[var(--accent)]">
                        {collection.label}
                      </Link>
                    </Card.Title>
                    <Card.Description>
                      {count.published + count.changed} en ligne · {count.draft} brouillon{count.draft > 1 ? 's' : ''}
                      {count.changed ? ` · ${count.changed} modifié${count.changed > 1 ? 's' : ''}` : ''}
                    </Card.Description>
                  </Card.Header>
                </Card>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
