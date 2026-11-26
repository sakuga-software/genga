import { useState } from 'react';
import { AlertDialog, Button, Chip, Drawer, Input, Label, TextField } from '@heroui/react';
import type { VersionSummary } from '../../types';
import { formatDateTime } from '../components/format';

const KIND_LABELS: Record<VersionSummary['kind'], string> = {
  published: 'Publiée',
  draft: 'Enregistrée',
  restored: 'Restaurée',
};

type VersionsDrawerProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  versions: VersionSummary[];
  onRestore: (versionId: string) => Promise<void>;
  onSaveVersion: (note: string) => Promise<void>;
};

export function VersionsDrawer({ isOpen, onOpenChange, versions, onRestore, onSaveVersion }: VersionsDrawerProps) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<VersionSummary | null>(null);
  const [restoring, setRestoring] = useState(false);

  return (
    <>
      <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Drawer.Content placement="right">
          <Drawer.Dialog aria-label="Versions">
            <Drawer.CloseTrigger aria-label="Fermer" />
            <Drawer.Header>
              <Drawer.Heading className="genga-display">Versions</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body className="flex flex-col gap-6">
              <form
                className="flex flex-col items-start gap-2"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setSaving(true);
                  try {
                    await onSaveVersion(note);
                    setNote('');
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                <TextField value={note} onChange={setNote} className="w-full" maxLength={200}>
                  <Label>Note de version (facultatif)</Label>
                  <Input placeholder="Avant refonte de l’intro" />
                </TextField>
                <Button type="submit" variant="secondary" isPending={saving}>
                  Enregistrer une version
                </Button>
              </form>
              <ol className="flex flex-col gap-2" aria-label="Historique">
                {versions.map((version) => (
                  <li key={version.id} className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{formatDateTime(version.createdAt)}</span>
                        <Chip size="sm" variant="soft" color={version.kind === 'published' ? 'success' : 'default'}>
                          {KIND_LABELS[version.kind]}
                        </Chip>
                        {version.isPublished && (
                          <Chip size="sm" variant="primary" color="success">
                            En ligne
                          </Chip>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {version.authorName || 'Inconnu'}
                        {version.note ? ` · ${version.note}` : ''}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => setConfirm(version)}
                      aria-label={`Restaurer la version du ${formatDateTime(version.createdAt)}`}
                    >
                      Restaurer
                    </Button>
                  </li>
                ))}
                {versions.length === 0 && (
                  <li className="text-sm text-[var(--muted)]">
                    Aucune version. La publication et le bouton ci-dessus en créent une.
                  </li>
                )}
              </ol>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>

      <AlertDialog.Backdrop isOpen={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning" />
              <AlertDialog.Heading>Restaurer cette version ?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>
                Le brouillon reprend le contenu du {confirm ? formatDateTime(confirm.createdAt) : ''}. Le site ne change
                pas avant la prochaine publication.
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">
                Annuler
              </Button>
              <Button
                variant="primary"
                isPending={restoring}
                onPress={async () => {
                  if (!confirm) return;
                  setRestoring(true);
                  try {
                    await onRestore(confirm.id);
                    setConfirm(null);
                    onOpenChange(false);
                  } finally {
                    setRestoring(false);
                  }
                }}
              >
                Restaurer
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}
