import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AlertDialog,
  Button,
  Checkbox,
  CheckboxGroup,
  Chip,
  Description,
  Input,
  Label,
  ListBox,
  Select,
  Table,
  TextField,
  toast,
} from '@heroui/react';
import { Copy } from 'lucide-react';
import { Form, useLoaderData, useRevalidator } from 'react-router';
import { API_SCOPES, type ApiScope } from '../../access';
import { ApiError, apiRequest } from '../../client/api';
import type { ApiTokenItem, OAuthGrantItem, TokensPageData } from '../../types';
import { formatDate, formatDateTime } from '../components/format';
import { LiveRegion } from '../components/live-region';
import { PageHeader } from '../components/page-header';
import { SCOPE_LABELS } from './scope-labels';

const EXPIRY_OPTIONS = [
  { id: '30', label: '30 jours', days: 30 },
  { id: '90', label: '90 jours', days: 90 },
  { id: '365', label: '1 an', days: 365 },
  { id: 'never', label: 'Jamais', days: null },
] as const;

function NewToken({ token, onDone }: { token: string; onDone: () => void }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <Alert status="success" className="mb-6">
      <Alert.Content>
        <Alert.Title>
          <span ref={titleRef} tabIndex={-1} className="outline-none">
            Jeton créé
          </span>
        </Alert.Title>
        <Alert.Description>
          Copiez ce jeton maintenant : il ne s’affichera plus. Gardez-le comme un mot de passe.
          <span className="genga-mono mt-2 block break-all rounded bg-[var(--surface-secondary)] p-2 text-xs">
            {token}
          </span>
          <span className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                void navigator.clipboard.writeText(token).then(
                  () =>
                    setAnnouncement(`Jeton copié dans le presse-papiers à ${new Date().toLocaleTimeString('fr-FR')}.`),
                  () => setAnnouncement('La copie a échoué. Sélectionnez le jeton et copiez-le à la main.'),
                );
              }}
            >
              <Copy aria-hidden className="size-4" /> Copier le jeton
            </Button>
            <Button size="sm" variant="ghost" onPress={onDone}>
              J’ai copié le jeton
            </Button>
          </span>
        </Alert.Description>
      </Alert.Content>
      <LiveRegion message={announcement} minIntervalMs={0} />
    </Alert>
  );
}

function ScopeChips({ scopes }: { scopes: ApiScope[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <Chip key={scope} size="sm" variant="soft">
          {SCOPE_LABELS[scope].label}
        </Chip>
      ))}
    </span>
  );
}

function Expiry({ token }: { token: ApiTokenItem }) {
  if (token.expired) {
    return (
      <Chip size="sm" variant="soft" color="danger">
        Expiré
      </Chip>
    );
  }
  return <>{token.expiresAt ? formatDate(token.expiresAt) : 'Jamais'}</>;
}

function TokensTable({
  label,
  tokens,
  showOwner,
  onRevoke,
}: {
  label: string;
  tokens: ApiTokenItem[];
  showOwner: boolean;
  onRevoke: (token: ApiTokenItem) => void;
}) {
  if (!tokens.length) {
    return <p className="text-sm text-[var(--muted)]">Aucun jeton actif.</p>;
  }
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label={label} className="min-w-[760px]">
          <Table.Header>
            <Table.Column isRowHeader>Nom</Table.Column>
            {showOwner ? <Table.Column>Personne</Table.Column> : null}
            <Table.Column>Portées</Table.Column>
            <Table.Column>Dernière utilisation</Table.Column>
            <Table.Column>Créé le</Table.Column>
            <Table.Column>Expiration</Table.Column>
            <Table.Column>Actions</Table.Column>
          </Table.Header>
          <Table.Body>
            {tokens.map((token) => (
              <Table.Row key={token.id} id={token.id}>
                <Table.Cell>
                  <span className="font-medium">{token.name}</span>
                </Table.Cell>
                {showOwner ? <Table.Cell>{token.user.name || token.user.email}</Table.Cell> : null}
                <Table.Cell>
                  <ScopeChips scopes={token.scopes} />
                </Table.Cell>
                <Table.Cell>{token.lastUsedAt ? formatDateTime(token.lastUsedAt) : 'Jamais'}</Table.Cell>
                <Table.Cell>{formatDate(token.createdAt)}</Table.Cell>
                <Table.Cell>
                  <Expiry token={token} />
                </Table.Cell>
                <Table.Cell>
                  <Button
                    size="sm"
                    variant="danger-soft"
                    onPress={() => onRevoke(token)}
                    aria-label={`Révoquer le jeton ${token.name}${showOwner ? ` de ${token.user.email}` : ''}`}
                  >
                    Révoquer
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}

function GrantsTable({
  label,
  grants,
  showOwner,
  onRevoke,
}: {
  label: string;
  grants: OAuthGrantItem[];
  showOwner: boolean;
  onRevoke: (grant: OAuthGrantItem) => void;
}) {
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label={label} className="min-w-[760px]">
          <Table.Header>
            <Table.Column isRowHeader>Application</Table.Column>
            {showOwner ? <Table.Column>Personne</Table.Column> : null}
            <Table.Column>Portées</Table.Column>
            <Table.Column>Dernière utilisation</Table.Column>
            <Table.Column>Connectée le</Table.Column>
            <Table.Column>Actions</Table.Column>
          </Table.Header>
          <Table.Body>
            {grants.map((grant) => (
              <Table.Row key={grant.id} id={grant.id}>
                <Table.Cell>
                  <span className="font-medium">{grant.clientName}</span>
                  <span className="block text-xs text-[var(--muted)]">
                    {grant.clientHost ?? 'Enregistrée automatiquement'}
                  </span>
                </Table.Cell>
                {showOwner ? <Table.Cell>{grant.user.name || grant.user.email}</Table.Cell> : null}
                <Table.Cell>
                  <ScopeChips scopes={grant.scopes} />
                </Table.Cell>
                <Table.Cell>{grant.lastUsedAt ? formatDateTime(grant.lastUsedAt) : 'Jamais'}</Table.Cell>
                <Table.Cell>{formatDate(grant.createdAt)}</Table.Cell>
                <Table.Cell>
                  <Button
                    size="sm"
                    variant="danger-soft"
                    onPress={() => onRevoke(grant)}
                    aria-label={`Déconnecter ${grant.clientName}${showOwner ? ` de ${grant.user.email}` : ''}`}
                  >
                    Déconnecter
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}

type Revocation = { kind: 'token'; item: ApiTokenItem } | { kind: 'grant'; item: OAuthGrantItem };

function revocationName(revocation: Revocation | null): string {
  if (!revocation) return '';
  return revocation.kind === 'token' ? revocation.item.name : revocation.item.clientName;
}

export function TokensPage() {
  const { tokens, allTokens, grants, allGrants, mcpUrl, currentUserId, canPublish } = useLoaderData() as TokensPageData;
  const revalidator = useRevalidator();
  const [scopes, setScopes] = useState<string[]>(['read', 'write']);
  const [expiry, setExpiry] = useState<string>('90');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The dialog keeps its target after it closes, so its title stays during the exit animation.
  const [confirm, setConfirm] = useState<Revocation | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  async function create(form: HTMLFormElement) {
    const data = new FormData(form);
    const days = EXPIRY_OPTIONS.find((option) => option.id === expiry)?.days ?? null;
    setCreating(true);
    setError(null);
    try {
      const result = await apiRequest<{ token: string }>('tokens', {
        method: 'POST',
        json: {
          name: data.get('name'),
          scopes,
          expiresAt: days === null ? null : new Date(Date.now() + days * 24 * 60 * 60_000).toISOString(),
        },
      });
      setCreated(result.token);
      form.reset();
      revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Création impossible.');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(revocation: Revocation) {
    setRevoking(true);
    try {
      if (revocation.kind === 'token') {
        await apiRequest(`tokens/${revocation.item.id}`, { method: 'DELETE' });
        toast.success(`Le jeton « ${revocation.item.name} » est révoqué.`);
      } else {
        await apiRequest(`grants/${revocation.item.id}`, { method: 'DELETE' });
        toast.success(`« ${revocation.item.clientName} » est déconnectée.`);
      }
      setConfirmOpen(false);
      revalidator.revalidate();
    } catch (caught) {
      toast.danger(caught instanceof ApiError ? caught.message : 'Révocation impossible.');
    } finally {
      setRevoking(false);
    }
  }

  function askRevoke(revocation: Revocation) {
    setConfirm(revocation);
    setConfirmOpen(true);
  }

  const askRevokeToken = (item: ApiTokenItem) => askRevoke({ kind: 'token', item });
  const askRevokeGrant = (item: OAuthGrantItem) => askRevoke({ kind: 'grant', item });
  const others = allTokens?.filter((token) => token.user.id !== currentUserId) ?? null;
  const otherGrants = allGrants?.filter((grant) => grant.user.id !== currentUserId) ?? null;

  return (
    <div className="p-6 md:p-10">
      <PageHeader
        title="Jetons d’accès"
        description="Un client MCP (Claude, Cursor, VS Code) agit en votre nom avec une connexion OAuth ou avec un jeton. Ses droits sont ses portées, dans la limite de votre rôle."
      />
      {mcpUrl && (
        <section
          aria-labelledby="apps-heading"
          className="mb-10 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
        >
          <h2 id="apps-heading" className="genga-display mb-1 text-lg font-semibold">
            Applications connectées
          </h2>
          <p className="mb-4 text-sm text-[var(--muted)]">
            Ajoutez l’adresse <span className="genga-mono break-all text-[var(--foreground)]">{mcpUrl}</span> dans votre
            client MCP. Il ouvre une page de Genga qui demande votre accord : aucun jeton à copier.
          </p>
          {grants.length ? (
            <GrantsTable label="Applications connectées" grants={grants} showOwner={false} onRevoke={askRevokeGrant} />
          ) : (
            <p className="text-sm text-[var(--muted)]">Aucune application connectée.</p>
          )}
        </section>
      )}
      {created && <NewToken token={created} onDone={() => setCreated(null)} />}
      <section
        aria-labelledby="new-token-heading"
        className="mb-10 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
      >
        <h2 id="new-token-heading" className="genga-display mb-4 text-lg font-semibold">
          Nouveau jeton
        </h2>
        <Form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void create(event.currentTarget);
          }}
        >
          <div className="flex flex-wrap items-start gap-3">
            <TextField name="name" isRequired maxLength={100} className="min-w-64 flex-1">
              <Label>Nom</Label>
              <Input placeholder="Claude Code, portable" />
              <Description>Pour reconnaître le jeton dans la liste.</Description>
            </TextField>
            <Select value={expiry} onChange={(key) => key && setExpiry(String(key))} className="w-44">
              <Label>Expiration</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {EXPIRY_OPTIONS.map((option) => (
                    <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
                      {option.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          <CheckboxGroup value={scopes} onChange={setScopes} isRequired name="scopes">
            <Label>Portées</Label>
            <div className="mt-2 flex flex-col gap-3">
              {API_SCOPES.map((scope) => (
                <Checkbox key={scope} value={scope}>
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Label>{SCOPE_LABELS[scope].label}</Label>
                  </Checkbox.Content>
                  <Description>
                    {SCOPE_LABELS[scope].description}
                    {scope === 'publish' && !canPublish
                      ? ' Votre rôle ne permet pas de publier : cette portée restera sans effet.'
                      : ''}
                  </Description>
                </Checkbox>
              ))}
            </div>
          </CheckboxGroup>
          <div>
            <Button type="submit" variant="primary" isPending={creating} isDisabled={!scopes.length}>
              Créer le jeton
            </Button>
          </div>
        </Form>
        {error && (
          <p role="alert" className="mt-3 text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
      </section>

      <section aria-labelledby="my-tokens-heading" className="mb-10">
        <h2 id="my-tokens-heading" className="genga-display mb-4 text-lg font-semibold">
          Mes jetons
        </h2>
        <TokensTable label="Mes jetons" tokens={tokens} showOwner={false} onRevoke={askRevokeToken} />
      </section>

      {others && (
        <section aria-labelledby="all-tokens-heading">
          <h2 id="all-tokens-heading" className="genga-display mb-1 text-lg font-semibold">
            Jetons des autres personnes
          </h2>
          <p className="mb-4 text-sm text-[var(--muted)]">
            En tant qu’administrateur, vous pouvez révoquer le jeton de toute personne.
          </p>
          <TokensTable label="Jetons des autres personnes" tokens={others} showOwner onRevoke={askRevokeToken} />
        </section>
      )}

      {otherGrants && mcpUrl && (
        <section aria-labelledby="all-grants-heading" className="mt-10">
          <h2 id="all-grants-heading" className="genga-display mb-1 text-lg font-semibold">
            Applications des autres personnes
          </h2>
          <p className="mb-4 text-sm text-[var(--muted)]">
            En tant qu’administrateur, vous pouvez déconnecter l’application de toute personne.
          </p>
          {otherGrants.length ? (
            <GrantsTable
              label="Applications des autres personnes"
              grants={otherGrants}
              showOwner
              onRevoke={askRevokeGrant}
            />
          ) : (
            <p className="text-sm text-[var(--muted)]">Aucune application connectée.</p>
          )}
        </section>
      )}

      <AlertDialog.Backdrop isOpen={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>
                {confirm?.kind === 'grant' ? 'Déconnecter' : 'Révoquer'} « {revocationName(confirm)} » ?
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>
                {confirm?.kind === 'grant'
                  ? 'L’application perd l’accès tout de suite. Pour la reconnecter, il faudra l’autoriser à nouveau.'
                  : 'Les clients qui utilisent ce jeton perdent l’accès tout de suite. Cette action est définitive.'}
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">
                Annuler
              </Button>
              <Button variant="danger" isPending={revoking} onPress={() => confirm && void revoke(confirm)}>
                {confirm?.kind === 'grant' ? 'Déconnecter' : 'Révoquer'}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  );
}
