import { useState } from 'react';
import { Button } from '@heroui/react';
import { CircleAlert, CircleCheck, CloudUpload, Loader2 } from 'lucide-react';
import { DropZone, FileTrigger, Text, type DropItem } from 'react-aria-components';
import { ApiError, apiRequest } from '../../client/api';
import type { MediaItem } from '../../types';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'application/pdf'];
export const ACCEPT = ACCEPTED_TYPES.join(',');

type UploadState = { name: string; status: 'uploading' | 'complete' | 'failed'; message?: string };

export async function uploadFile(file: File): Promise<{ media: MediaItem; deduplicated: boolean }> {
  const form = new FormData();
  form.append('file', file);
  return apiRequest('media', { method: 'POST', body: form });
}

async function filesOf(items: DropItem[]): Promise<File[]> {
  const files: File[] = [];
  for (const item of items) {
    if (item.kind === 'file') files.push(await item.getFile());
  }
  return files;
}

const STATUS_ICONS = { uploading: Loader2, complete: CircleCheck, failed: CircleAlert };

/** Upload area: drag and drop, paste, or file picker. The server checks the real type of each file. */
export function MediaUpload({
  onUploaded,
  compact = false,
}: {
  onUploaded: (media: MediaItem) => void;
  compact?: boolean;
}) {
  const [uploads, setUploads] = useState<UploadState[]>([]);

  async function send(files: File[]) {
    for (const file of files) {
      setUploads((current) => [
        { name: file.name, status: 'uploading' },
        ...current.filter((item) => item.name !== file.name),
      ]);
      try {
        const result = await uploadFile(file);
        onUploaded(result.media);
        setUploads((current) =>
          current.map((item) =>
            item.name === file.name
              ? { ...item, status: 'complete', message: result.deduplicated ? 'Déjà dans la médiathèque' : 'Envoyé' }
              : item,
          ),
        );
      } catch (error) {
        const message = error instanceof ApiError ? error.message : 'Échec de l’envoi.';
        setUploads((current) =>
          current.map((item) => (item.name === file.name ? { ...item, status: 'failed', message } : item)),
        );
      }
    }
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <DropZone
        getDropOperation={(types) => (ACCEPTED_TYPES.some((type) => types.has(type)) ? 'copy' : 'cancel')}
        onDrop={async (event) => void send(await filesOf(event.items))}
        className={({ isDropTarget, isFocusVisible }) =>
          `flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 text-center transition-colors ${
            compact ? 'py-6' : 'py-10'
          } ${
            isDropTarget
              ? 'border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]'
              : 'border-[var(--border)] bg-[var(--surface)]'
          } ${isFocusVisible ? 'outline-2 outline-offset-2 outline-[var(--focus)]' : ''}`
        }
      >
        <span
          aria-hidden
          className="grid size-10 place-items-center rounded-full bg-[var(--surface-secondary)] text-[var(--muted)]"
        >
          <CloudUpload className="size-5" />
        </span>
        <Text slot="label" className="font-medium">
          Déposez des fichiers ici
        </Text>
        <p className="text-sm text-[var(--muted)]">JPEG, PNG, WebP, AVIF, GIF ou PDF · 20 Mo max</p>
        <FileTrigger
          acceptedFileTypes={ACCEPTED_TYPES}
          allowsMultiple
          onSelect={(files) => void send(Array.from(files ?? []))}
        >
          <Button variant="secondary" size="sm" className="mt-1">
            Parcourir
          </Button>
        </FileTrigger>
      </DropZone>
      <ul aria-live="polite" aria-label="Envois" className={uploads.length ? 'flex flex-col gap-2' : 'sr-only'}>
        {uploads.map((item) => {
          const Icon = STATUS_ICONS[item.status];
          return (
            <li
              key={item.name}
              className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            >
              <Icon
                aria-hidden
                className={`size-4 shrink-0 ${item.status === 'uploading' ? 'animate-spin text-[var(--muted)]' : ''} ${
                  item.status === 'complete' ? 'text-[var(--success)]' : ''
                } ${item.status === 'failed' ? 'text-[var(--danger)]' : ''}`}
              />
              <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
              <span className="text-xs text-[var(--muted)]">
                {item.status === 'uploading' ? 'Envoi…' : item.message}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
