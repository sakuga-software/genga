import { useEffect, useState } from 'react';
import { Button, Modal, SearchField, Spinner } from '@heroui/react';
import { apiRequest } from '../../client/api';
import type { MediaItem } from '../../types';
import { MediaThumb } from './media-thumb';
import { MediaUpload } from './media-upload';

type MediaPickerProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (media: MediaItem) => void;
  imagesOnly?: boolean;
};

export function MediaPicker({ isOpen, onOpenChange, onSelect, imagesOnly = false }: MediaPickerProps) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      apiRequest<{ media: MediaItem[] }>(`media?q=${encodeURIComponent(search)}`)
        .then((result) => !cancelled && setItems(result.media))
        .catch(() => !cancelled && setItems([]));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, search]);

  const visible = (items ?? []).filter((item) => !imagesOnly || item.mime.startsWith('image/'));

  function choose(media: MediaItem) {
    onSelect(media);
    onOpenChange(false);
  }

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-label="Choisir un média">
          <Modal.CloseTrigger aria-label="Fermer" />
          <Modal.Header>
            <Modal.Heading className="genga-display">Choisir un média</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            <MediaUpload compact onUploaded={(media) => choose(media)} />
            <SearchField value={search} onChange={setSearch} aria-label="Rechercher un média">
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Rechercher par nom ou texte alternatif" />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            {items === null ? (
              <div className="grid place-items-center py-10">
                <Spinner aria-label="Chargement" />
              </div>
            ) : (
              <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3" aria-label="Médias">
                {visible.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => choose(item)}
                      className="group block w-full overflow-hidden rounded-lg border border-[var(--border)] text-left hover:border-[var(--accent)]"
                    >
                      <MediaThumb media={item} className="aspect-[4/3] w-full" />
                      <span className="block truncate px-2 py-1.5 text-xs">{item.filename}</span>
                      <span className="sr-only">{item.alt ? `, ${item.alt}` : ', sans texte alternatif'}</span>
                    </button>
                  </li>
                ))}
                {visible.length === 0 && (
                  <li className="col-span-full py-8 text-center text-sm text-[var(--muted)]">Aucun média.</li>
                )}
              </ul>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" slot="close">
              Annuler
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
