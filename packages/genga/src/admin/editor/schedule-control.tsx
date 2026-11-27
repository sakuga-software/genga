import { useState } from 'react';
import { Button, Description, Input, Label, Popover, TextField } from '@heroui/react';
import { CalendarClock, CircleAlert } from 'lucide-react';
import { ApiError, apiRequest } from '../../client/api';
import type { DocumentSchedule, ScheduleAction } from '../../types';
import { formatDateTime } from '../components/format';

const ACTION_LABELS: Record<ScheduleAction, { field: string; planned: string; failed: string }> = {
  publish: { field: 'Publier le', planned: 'Publication prévue le', failed: 'La publication programmée a échoué' },
  unpublish: {
    field: 'Dépublier le',
    planned: 'Dépublication prévue le',
    failed: 'La dépublication programmée a échoué',
  },
};

const ACTIONS: ScheduleAction[] = ['publish', 'unpublish'];

/** `datetime-local` has no time zone: the value is the local time of the browser. */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `null` clears the date; `undefined` is a value that the browser cannot read as a date. */
function fromLocalInput(value: string): string | null | undefined {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function hasSchedule(schedule: DocumentSchedule) {
  return Boolean(schedule.publish || schedule.unpublish);
}

/** The planned dates and the errors of a failed run, under the title of the editor. */
export function ScheduleSummary({ schedule }: { schedule: DocumentSchedule }) {
  return ACTIONS.map((action) => {
    const entry = schedule[action];
    if (!entry) return null;
    if (entry.failedAt) {
      return (
        <span key={action} className="inline-flex items-center gap-1 text-xs text-[var(--danger)]">
          <CircleAlert aria-hidden className="size-3.5" />
          {ACTION_LABELS[action].failed} : {entry.error}
        </span>
      );
    }
    return (
      <span key={action} className="inline-flex items-center gap-1 text-xs text-[var(--muted)]">
        <CalendarClock aria-hidden className="size-3.5" />
        {ACTION_LABELS[action].planned} {formatDateTime(entry.at)}
      </span>
    );
  });
}

type ScheduleControlProps = {
  documentId: string;
  schedule: DocumentSchedule;
  onSaved: (schedule: DocumentSchedule, message: string) => void;
};

/** Sets or clears the dates of a scheduled publish and unpublish. */
export function ScheduleControl({ documentId, schedule, onSaved }: ScheduleControlProps) {
  const [isOpen, setOpen] = useState(false);
  const [values, setValues] = useState<Record<ScheduleAction, string>>({ publish: '', unpublish: '' });
  const [initial, setInitial] = useState<Record<ScheduleAction, string>>({ publish: '', unpublish: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function open(next: boolean) {
    if (next) {
      const loaded = { publish: toLocalInput(schedule.publish?.at), unpublish: toLocalInput(schedule.unpublish?.at) };
      setValues(loaded);
      setInitial(loaded);
      setError(null);
    }
    setOpen(next);
  }

  async function save(next: Record<ScheduleAction, string>) {
    // Only the changed dates go to the server: another editor can have changed the other one.
    const body: Partial<Record<`${ScheduleAction}At`, string | null>> = {};
    for (const action of ACTIONS) {
      if (next[action] === initial[action]) continue;
      const value = fromLocalInput(next[action]);
      if (value === undefined) {
        setError('Cette date est incomplète.');
        return;
      }
      if (value && new Date(value).getTime() <= Date.now()) {
        setError('Choisissez une date dans le futur.');
        return;
      }
      body[`${action}At`] = value;
    }
    if (!Object.keys(body).length) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      const result = await apiRequest<{ schedule: DocumentSchedule }>(`documents/${documentId}/schedule`, {
        method: 'PUT',
        json: body,
      });
      setOpen(false);
      onSaved(result.schedule, hasSchedule(result.schedule) ? 'Programmation enregistrée.' : 'Programmation annulée.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'La programmation n’a pas pu être enregistrée.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover isOpen={isOpen} onOpenChange={open}>
      <Button
        variant="ghost"
        size="sm"
        aria-label={hasSchedule(schedule) ? 'Programmer (dates enregistrées)' : 'Programmer'}
      >
        <CalendarClock aria-hidden className="size-4" /> Programmer
        {hasSchedule(schedule) && <span aria-hidden className="size-1.5 rounded-full bg-[var(--accent)]" />}
      </Button>
      <Popover.Content placement="bottom end" className="w-80">
        <Popover.Dialog aria-label="Programmer la publication">
          <form
            className="flex flex-col gap-3 p-1"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void save(values);
            }}
          >
            {ACTIONS.map((action) => (
              <TextField
                key={action}
                value={values[action]}
                onChange={(value) => {
                  setValues((current) => ({ ...current, [action]: value }));
                  setError(null);
                }}
                fullWidth
              >
                <Label>{ACTION_LABELS[action].field}</Label>
                <Input type="datetime-local" />
                {action === 'publish' && <Description>Le brouillon de cette date sera publié.</Description>}
              </TextField>
            ))}
            {error && (
              <p role="alert" className="text-xs text-[var(--danger)]">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              {hasSchedule(schedule) && (
                <Button
                  size="sm"
                  variant="tertiary"
                  isDisabled={busy}
                  onPress={() => void save({ publish: '', unpublish: '' })}
                >
                  Tout annuler
                </Button>
              )}
              <Button size="sm" variant="primary" type="submit" isPending={busy}>
                Enregistrer
              </Button>
            </div>
          </form>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
