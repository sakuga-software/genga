import { useCallback, useMemo, useState } from 'react';
import {
  AlertDialog,
  Alert,
  Button,
  Description,
  Dropdown,
  FieldError,
  Input,
  Label,
  TextField,
  toast,
} from '@heroui/react';
import { ArrowLeft, Check, CircleAlert, CloudUpload, EllipsisVertical, History, Loader2, Wand2 } from 'lucide-react';
import { Link, useLoaderData, useNavigate } from 'react-router';
import { ApiError, apiRequest } from '../../client/api';
import { blockSchemasFromSerialized } from '../../config';
import type { MediaObject } from '../../fields/types';
import { populate } from '../../populate';
import { slugify } from '../../slugify';
import type { AdminDocument, DocumentPageData, DocumentStatus, VersionSummary } from '../../types';
import { formatDateTime } from '../components/format';
import { LiveRegion } from '../components/live-region';
import { StatusChip } from '../components/status-chip';
import { SplitPane } from '../ui/split-pane';
import { EditorContext, type EditorContextValue } from './editor-context';
import { FieldInput } from './field-input';
import { PreviewPane } from './preview-pane';
import { issuesToErrors, useDraft, type SaveState } from './use-draft';
import { VersionsDrawer } from './versions-drawer';

const SAVE_LABELS: Record<SaveState, string> = {
  saved: 'Enregistré',
  dirty: 'Modifications non enregistrées',
  saving: 'Enregistrement…',
  error: 'Échec de l’enregistrement',
  conflict: 'Conflit de version',
};

function SaveIndicator({ state, savedAt }: { state: SaveState; savedAt: string | null }) {
  const icons: Record<SaveState, typeof Check> = {
    saved: Check,
    dirty: CloudUpload,
    saving: Loader2,
    error: CircleAlert,
    conflict: CircleAlert,
  };
  const Icon = icons[state];
  const tone = state === 'error' || state === 'conflict' ? 'text-[var(--danger)]' : 'text-[var(--muted)]';
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${tone}`}
      title={savedAt ? `Dernier enregistrement : ${formatDateTime(savedAt)}` : undefined}
    >
      <Icon aria-hidden className={`size-3.5 ${state === 'saving' ? 'animate-spin' : ''}`} />
      {SAVE_LABELS[state]}
    </span>
  );
}

export function DocumentPage() {
  const loaded = useLoaderData() as DocumentPageData;
  return <DocumentEditor key={loaded.document.id} loaded={loaded} />;
}

function DocumentEditor({ loaded }: { loaded: DocumentPageData }) {
  const navigate = useNavigate();
  const { schema } = loaded;
  const [doc, setDoc] = useState<AdminDocument>(loaded.document);
  const [versions, setVersions] = useState<VersionSummary[]>(loaded.versions);
  const collection = schema.collections[doc.collection];
  const blocks = useMemo(() => blockSchemasFromSerialized(schema), [schema]);
  const [media, setMedia] = useState<Map<string, MediaObject>>(() => new Map(Object.entries(doc.media)));
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState<'publish' | 'unpublish' | 'delete' | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [publishErrors, setPublishErrors] = useState<string[]>([]);
  const [slugTouched, setSlugTouched] = useState(() => {
    const initialTitle = String(doc.draft[collection.titleField] ?? '');
    return Boolean(doc.publishedSlug) || (initialTitle !== '' && doc.draft.slug !== slugify(initialTitle));
  });

  const draft = useDraft({
    documentId: doc.id,
    initialData: doc.draft,
    initialRev: doc.draftRev,
    initialStatus: doc.status,
    initialSlug: doc.slug,
    initialPreviewPath: doc.previewPath,
  });

  const rememberMedia = useCallback((item: MediaObject) => {
    setMedia((current) => new Map(current).set(item.id, item));
  }, []);

  const selectBlock = useCallback((id: string | null) => setSelectedBlockId(id), []);

  const context: EditorContextValue = {
    schema,
    media,
    rememberMedia,
    errors: draft.fieldErrors,
    selectedBlockId,
    selectBlock,
    epoch,
    readOnly: false,
  };

  const populated = useMemo(
    () => populate(collection.fields, draft.data, blocks, media),
    [collection.fields, draft.data, blocks, media],
  );

  const title = String(draft.data[collection.titleField] ?? '') || 'Sans titre';
  const draftSlug = String(draft.data.slug ?? '');

  function setField(name: string, value: unknown) {
    const next = { ...draft.data, [name]: value };
    if (name === collection.titleField && !slugTouched && !doc.publishedSlug) next.slug = slugify(String(value));
    draft.change(next);
  }

  async function publish() {
    setBusy('publish');
    setPublishErrors([]);
    try {
      if (!(await draft.save())) return;
      const result = await apiRequest<{
        status: DocumentStatus;
        slug: string;
        previousSlug: string | null;
        previewPath: string;
        publishedAt: string;
      }>(`documents/${doc.id}/publish`, { method: 'POST', json: { draftRev: draft.rev.current } });
      draft.setStatus(result.status);
      draft.setSlug(result.slug);
      draft.setPreviewPath(result.previewPath);
      setDoc((current) => ({
        ...current,
        publishedSlug: result.slug,
        slug: result.slug,
        publishedAt: result.publishedAt,
      }));
      setSlugTouched(true);
      const message = result.previousSlug
        ? `Publié. L’ancienne adresse /${result.previousSlug} redirige vers la nouvelle.`
        : 'Publié sur le site.';
      setAnnouncement(message);
      toast.success(message);
      void refreshVersions();
    } catch (error) {
      if (error instanceof ApiError && error.status === 422 && Array.isArray(error.details)) {
        draft.setFieldErrors(issuesToErrors(error.details));
        setPublishErrors(
          (error.details as { message: string; path: (string | number)[] }[]).map(
            (issue) => `${issue.path.join(' › ')} : ${issue.message}`,
          ),
        );
      }
      const message = error instanceof ApiError ? error.message : 'Publication impossible.';
      setAnnouncement(`Erreur : ${message}`);
      toast.danger(message);
    } finally {
      setBusy(null);
    }
  }

  async function unpublish() {
    setBusy('unpublish');
    try {
      const result = await apiRequest<{ status: DocumentStatus }>(`documents/${doc.id}/unpublish`, { method: 'POST' });
      draft.setStatus(result.status);
      setDoc((current) => ({ ...current, publishedAt: null }));
      setAnnouncement('Dépublié : la page n’est plus visible sur le site.');
      toast('Dépublié');
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Action impossible.');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('delete');
    try {
      await apiRequest(`documents/${doc.id}`, { method: 'DELETE' });
      toast('Document supprimé');
      draft.discard();
      navigate(`/admin/collections/${doc.collection}`);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Suppression impossible.');
      setBusy(null);
    }
  }

  async function refreshVersions() {
    const result = await apiRequest<{ versions: VersionSummary[] }>(`documents/${doc.id}/versions`).catch(() => null);
    if (result) setVersions(result.versions);
  }

  async function restore(versionId: string) {
    if (!(await draft.save())) return;
    let result: {
      draftRev: number;
      status: DocumentStatus;
      draft: Record<string, unknown>;
      media: Record<string, MediaObject>;
    };
    try {
      result = await apiRequest(`documents/${doc.id}/restore`, {
        method: 'POST',
        json: { versionId, draftRev: draft.rev.current },
      });
    } catch (error) {
      let message = error instanceof ApiError ? error.message : 'Restauration impossible.';
      if (error instanceof ApiError && error.status === 409) {
        message = 'Le document a changé entre-temps. Rechargez-le avant de restaurer.';
      }
      setAnnouncement(`Erreur : ${message}`);
      toast.danger(message);
      return;
    }
    setMedia((current) => new Map([...current, ...Object.entries(result.media)]));
    draft.replace(result.draft, result.draftRev, result.status);
    setEpoch((value) => value + 1);
    setAnnouncement('Version restaurée dans le brouillon.');
    toast.success('Version restaurée dans le brouillon. Publiez pour la mettre en ligne.');
    void refreshVersions();
  }

  async function saveVersion(note: string) {
    if (!(await draft.save())) return;
    await apiRequest(`documents/${doc.id}/versions`, { method: 'POST', json: { note } });
    toast.success('Version enregistrée');
    void refreshVersions();
  }

  async function reloadFromServer() {
    const result = await apiRequest<{ document: AdminDocument }>(`documents/${doc.id}`);
    setMedia((current) => new Map([...current, ...Object.entries(result.document.media)]));
    draft.replace(result.document.draft, result.document.draftRev, result.document.status);
    setEpoch((value) => value + 1);
  }

  const saveAnnouncement =
    draft.saveState === 'dirty' || draft.saveState === 'saving' ? '' : SAVE_LABELS[draft.saveState];
  const previewSrc = `${draft.previewPath}?genga-preview=${doc.id}`;
  const slugPending = Boolean(doc.publishedSlug) && draftSlug !== '' && draftSlug !== doc.publishedSlug;

  return (
    <EditorContext.Provider value={context}>
      <LiveRegion message={announcement || saveAnnouncement} />
      <div className="flex h-[calc(100dvh-4rem)] min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-3 md:px-6">
          <Link
            to={`/admin/collections/${doc.collection}`}
            className="inline-flex size-8 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
            aria-label={`Retour : ${collection.label}`}
          >
            <ArrowLeft aria-hidden className="size-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="genga-display truncate text-xl font-semibold">{title}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-3">
              <StatusChip status={draft.status} />
              <SaveIndicator state={draft.saveState} savedAt={draft.savedAt} />
            </div>
          </div>
          <Button variant="ghost" size="sm" onPress={() => setVersionsOpen(true)}>
            <History aria-hidden className="size-4" /> Versions
          </Button>
          {doc.canPublish ? (
            <>
              {draft.status !== 'draft' && (
                <Button variant="secondary" size="sm" onPress={unpublish} isPending={busy === 'unpublish'}>
                  Dépublier
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onPress={publish}
                isPending={busy === 'publish'}
                isDisabled={draft.status === 'published' && draft.saveState === 'saved'}
              >
                {draft.status === 'draft' ? 'Publier' : 'Publier les modifications'}
              </Button>
            </>
          ) : (
            <span className="text-xs text-[var(--muted)]">Un éditeur publiera ce document.</span>
          )}
          {doc.canDelete && (
            <Dropdown>
              <Button isIconOnly size="sm" variant="ghost" aria-label="Plus d’actions">
                <EllipsisVertical aria-hidden className="size-4" />
              </Button>
              <Dropdown.Popover>
                <Dropdown.Menu
                  aria-label="Actions du document"
                  onAction={(key) => key === 'delete' && setDeleteOpen(true)}
                >
                  <Dropdown.Item id="delete" textValue="Supprimer" variant="danger">
                    <Label>Supprimer…</Label>
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          )}
        </div>

        <SplitPane
          className="flex-1"
          storageKey="editor"
          defaultSize={48}
          minStart={30}
          minEnd={25}
          separatorLabel="Redimensionner l’aperçu"
          start={
            <form
              aria-label={`Modifier : ${title}`}
              className="h-full overflow-y-auto px-4 py-6 md:px-8"
              onSubmit={(event) => {
                event.preventDefault();
                void draft.save();
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null) && draft.isDirty())
                  void draft.save();
              }}
            >
              <div className="mx-auto flex max-w-2xl flex-col gap-6">
                {draft.saveState === 'error' && draft.errorMessage && (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Title>Enregistrement impossible</Alert.Title>
                      <Alert.Description>{draft.errorMessage}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                )}
                {publishErrors.length > 0 && (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Title>Corrigez ces champs avant de publier</Alert.Title>
                      <Alert.Description>
                        <ul className="mt-1 list-disc pl-5">
                          {publishErrors.map((message) => (
                            <li key={message}>{message}</li>
                          ))}
                        </ul>
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                )}
                {Object.entries(collection.fields).map(([name, field]) =>
                  field.type === 'slug' ? (
                    <TextField
                      key={name}
                      value={draftSlug}
                      onChange={(value) => {
                        setSlugTouched(true);
                        draft.change({ ...draft.data, slug: value.toLowerCase().replace(/[^a-z0-9-]/g, '-') });
                      }}
                      isRequired
                      isInvalid={Boolean(draft.slugError || draft.fieldErrors.slug)}
                      fullWidth
                    >
                      <Label>{field.label ?? 'Slug'}</Label>
                      <div className="flex gap-2">
                        <Input className="genga-mono flex-1" />
                        <Button
                          isIconOnly
                          variant="secondary"
                          aria-label="Générer le slug depuis le titre"
                          onPress={() => {
                            setSlugTouched(true);
                            draft.change({ ...draft.data, slug: slugify(title) });
                          }}
                        >
                          <Wand2 aria-hidden className="size-4" />
                        </Button>
                      </div>
                      <Description>
                        {slugPending
                          ? `Adresse actuelle : ${doc.publishedSlug}. La nouvelle adresse prendra effet à la publication, et l’ancienne redirigera.`
                          : `Adresse : ${draft.previewPath}`}
                      </Description>
                      <FieldError>{draft.slugError ?? draft.fieldErrors.slug}</FieldError>
                    </TextField>
                  ) : (
                    <FieldInput
                      key={name}
                      name={name}
                      field={field}
                      value={draft.data[name]}
                      path={[name]}
                      onChange={(value) => setField(name, value)}
                    />
                  ),
                )}
              </div>
            </form>
          }
          end={
            <PreviewPane
              documentId={doc.id}
              src={previewSrc}
              data={populated as Record<string, unknown>}
              selectedBlockId={selectedBlockId}
              onSelectBlock={(id) => selectBlock(id)}
            />
          }
        />
      </div>

      <VersionsDrawer
        isOpen={versionsOpen}
        onOpenChange={setVersionsOpen}
        versions={versions}
        onRestore={restore}
        onSaveVersion={saveVersion}
      />

      <AlertDialog.Backdrop
        isOpen={draft.leavePrompt !== null}
        onOpenChange={(open) => !open && draft.leavePrompt?.stay()}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>Modifications non enregistrées</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>
                Vos dernières modifications n’ont pas pu être enregistrées. Si vous quittez la page, elles seront
                perdues.
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" onPress={() => draft.leavePrompt?.stay()}>
                Rester
              </Button>
              <Button variant="danger" onPress={() => draft.leavePrompt?.leave()}>
                Quitter sans enregistrer
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <AlertDialog.Backdrop
        isOpen={draft.saveState === 'conflict' && draft.leavePrompt === null}
        onOpenChange={() => undefined}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning" />
              <AlertDialog.Heading>Ce document a changé ailleurs</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>
                Quelqu’un a enregistré une autre version pendant que vous écriviez. Rechargez pour voir sa version, ou
                gardez la vôtre et remplacez la sienne.
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" onPress={() => void reloadFromServer()}>
                Recharger sa version
              </Button>
              <Button variant="danger" onPress={() => void draft.overwrite()}>
                Garder ma version
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <AlertDialog.Backdrop isOpen={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>Supprimer « {title} » ?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>Le document quitte le site et la liste. Son adresse redevient libre.</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">
                Annuler
              </Button>
              <Button variant="danger" onPress={remove} isPending={busy === 'delete'}>
                Supprimer
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </EditorContext.Provider>
  );
}
