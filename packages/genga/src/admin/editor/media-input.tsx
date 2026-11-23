import { useId, useState } from 'react';
import { Button } from '@heroui/react';
import { ImagePlus, X } from 'lucide-react';
import { MediaPicker } from '../components/media-picker';
import { MediaThumb } from '../components/media-thumb';
import { pathKey, useEditor } from './editor-context';

type MediaInputProps = {
  label: string;
  required?: boolean;
  description?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  path: (string | number)[];
};

export function MediaInput({ label, required, description, value, onChange, path }: MediaInputProps) {
  const { media, rememberMedia, errors, readOnly } = useEditor();
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const current = value ? media.get(value) : undefined;
  const error = errors[pathKey(path)];
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2">
      <span id={labelId} className="text-sm font-medium">
        {label}
        {required && (
          <span aria-hidden className="text-[var(--danger)]">
            {' '}
            *
          </span>
        )}
      </span>
      <div className="flex items-center gap-4 rounded-xl border border-dashed border-[var(--border)] p-3">
        {current ? (
          <MediaThumb media={current} className="size-20 shrink-0 rounded-lg" />
        ) : (
          <div className="grid size-20 shrink-0 place-items-center rounded-lg bg-[var(--surface-secondary)] text-[var(--muted)]">
            <ImagePlus aria-hidden className="size-6" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{current?.filename ?? (value ? 'Média introuvable' : 'Aucun média')}</p>
          {current && !current.alt && current.mime.startsWith('image/') && (
            <p className="text-xs text-[var(--warning)]">Sans texte alternatif : ajoutez-le dans la médiathèque.</p>
          )}
          {description && <p className="text-xs text-[var(--muted)]">{description}</p>}
          {!readOnly && (
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onPress={() => setOpen(true)}
                aria-label={`${current ? 'Remplacer' : 'Choisir'} : ${label}`}
              >
                {current ? 'Remplacer' : 'Choisir'}
              </Button>
              {value && (
                <Button size="sm" variant="ghost" onPress={() => onChange(null)} aria-label={`Retirer : ${label}`}>
                  <X aria-hidden className="size-4" /> Retirer
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      <MediaPicker
        isOpen={open}
        onOpenChange={setOpen}
        imagesOnly
        onSelect={(item) => {
          rememberMedia(item);
          onChange(item.id);
        }}
      />
    </div>
  );
}
