import { useState } from 'react';
import { Alert, Button, Description, Input, Label, Modal, TextField, toast } from '@heroui/react';
import { Image } from 'lucide-react';
import { useLoaderData, useRevalidator } from 'react-router';
import { ApiError, apiRequest } from '../../client/api';
import type { MediaItem, MediaPageData } from '../../types';
import { formatBytes, formatDate } from '../components/format';
import { MediaThumb } from '../components/media-thumb';
import { MediaUpload } from '../components/media-upload';
import { PageHeader } from '../components/page-header';
import { EmptyState } from '../ui/empty-state';

export function MediaPage() {
  const { media, canDelete, canUpload } = useLoaderData() as MediaPageData;
  const revalidator = useRevalidator();
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [alt, setAlt] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open(item: MediaItem) {
    setSelected(item);
    setAlt(item.alt);
    setError(null);
  }

  async function saveAlt() {
    if (!selected) return;
    setSaving(true);
    try {
      await apiRequest(`media/${selected.id}`, { method: 'PATCH', json: { alt } });
      toast.success('Texte alternatif enregistré');
      setSelected(null);
      revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Enregistrement impossible.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selected) return;
    setDeleting(true);
    setError(null);
    try {
      await apiRequest(`media/${selected.id}`, { method: 'DELETE' });
      toast('Média supprimé');
      setSelected(null);
      revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Suppression impossible.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="p-6 md:p-10">
      <PageHeader title="Médias" description={`${media.length} fichier${media.length > 1 ? 's' : ''}`} />
      {canUpload && (
        <div className="mb-8">
          <MediaUpload onUploaded={() => revalidator.revalidate()} />
        </div>
      )}
      {media.length === 0 ? (
        <EmptyState
          icon={<Image className="size-5" />}
          title="Médiathèque vide"
          description="Les images envoyées apparaissent ici."
        />
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6" aria-label="Fichiers">
          {media.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => open(item)}
                className="block w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] text-left hover:border-[var(--accent)]"
              >
                <MediaThumb media={item} className="aspect-square w-full" />
                <span className="block px-3 py-2">
                  <span className="block truncate text-sm">{item.filename}</span>
                  <span className="block text-xs text-[var(--muted)]">
                    {item.width && item.height ? `${item.width}×${item.height} · ` : ''}
                    {formatBytes(item.size)}
                  </span>
                  {!item.alt && item.mime.startsWith('image/') && (
                    <span className="block text-xs text-[var(--warning)]">Sans texte alternatif</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal.Backdrop isOpen={selected !== null} onOpenChange={(isOpen) => !isOpen && setSelected(null)}>
        <Modal.Container size="md">
          <Modal.Dialog aria-label="Détails du média">
            <Modal.CloseTrigger aria-label="Fermer" />
            <Modal.Header>
              <Modal.Heading className="genga-display truncate">{selected?.filename}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              {selected && (
                <>
                  <MediaThumb media={selected} className="max-h-72 w-full rounded-lg object-contain" />
                  <p className="text-xs text-[var(--muted)]">
                    {selected.mime} · {formatBytes(selected.size)} · ajouté le {formatDate(selected.createdAt)}
                  </p>
                  <TextField value={alt} onChange={setAlt} maxLength={500} fullWidth>
                    <Label>Texte alternatif</Label>
                    <Input />
                    <Description>
                      Décrit l’image pour les lecteurs d’écran. Laissez vide si l’image est décorative.
                    </Description>
                  </TextField>
                  {error && (
                    <Alert status="danger">
                      <Alert.Content>
                        <Alert.Description>{error}</Alert.Description>
                      </Alert.Content>
                    </Alert>
                  )}
                </>
              )}
            </Modal.Body>
            <Modal.Footer>
              {canDelete && (
                <Button variant="danger-soft" onPress={remove} isPending={deleting} className="mr-auto">
                  Supprimer
                </Button>
              )}
              <Button slot="close" variant="tertiary">
                Annuler
              </Button>
              <Button variant="primary" onPress={saveAlt} isPending={saving}>
                Enregistrer
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}
