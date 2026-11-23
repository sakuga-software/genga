import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { ApiError, apiRequest } from '../../client/api';
import type { DocumentStatus } from '../../types';
import { blockedNavigation, flushDraft, type SaveState } from './draft-flush';

export type { SaveState } from './draft-flush';

type SaveResponse = {
  draftRev: number;
  status: DocumentStatus;
  slug: string;
  slugError: string | null;
  previewPath: string;
  savedAt: string;
};

const AUTOSAVE_DELAY_MS = 1500;

/**
 * Holds the draft and saves it with the `draft_rev` compare-and-set.
 * A save starts 1.5 s after the last change, on blur, and before publish.
 * A client navigation waits for the save. If the save fails, the page asks
 * the user. On unmount, the last changes go out in one `keepalive` request.
 */
export function useDraft(options: {
  documentId: string;
  initialData: Record<string, unknown>;
  initialRev: number;
  initialStatus: DocumentStatus;
  initialSlug: string;
  initialPreviewPath: string;
}) {
  const [data, setData] = useState(options.initialData);
  const [status, setStatus] = useState<DocumentStatus>(options.initialStatus);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [slug, setSlug] = useState(options.initialSlug);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState(options.initialPreviewPath);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [conflictRev, setConflictRev] = useState<number | null>(null);

  const rev = useRef(options.initialRev);
  const latest = useRef(data);
  const dirty = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<number | null>(null);
  const saveStateRef = useRef<SaveState>('saved');
  saveStateRef.current = saveState;

  const save = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) await inFlight.current;
    if (!dirty.current) return true;
    const snapshot = latest.current;
    dirty.current = false;
    setSaveState('saving');
    const run = (async () => {
      try {
        const result = await apiRequest<SaveResponse>(`documents/${options.documentId}/draft`, {
          method: 'PUT',
          json: { data: snapshot, draftRev: rev.current },
        });
        rev.current = result.draftRev;
        setStatus(result.status);
        setSlug(result.slug);
        setSlugError(result.slugError);
        setPreviewPath(result.previewPath);
        setSavedAt(result.savedAt);
        setFieldErrors({});
        setErrorMessage(null);
        setSaveState(dirty.current ? 'dirty' : 'saved');
        return true;
      } catch (error) {
        dirty.current = true;
        if (error instanceof ApiError && error.status === 409) {
          setConflictRev((error.details as { draftRev?: number } | null)?.draftRev ?? null);
          setSaveState('conflict');
          return false;
        }
        if (error instanceof ApiError && error.status === 400 && Array.isArray(error.details)) {
          setFieldErrors(issuesToErrors(error.details));
        }
        setErrorMessage(error instanceof ApiError ? error.message : 'Enregistrement impossible.');
        setSaveState('error');
        return false;
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [options.documentId]);

  const change = useCallback(
    (next: Record<string, unknown>) => {
      latest.current = next;
      dirty.current = true;
      setData(next);
      setSaveState((current) => (current === 'conflict' ? current : 'dirty'));
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    },
    [save],
  );

  /** Replaces the draft with server data, after a restore or a reload. */
  const replace = useCallback((next: Record<string, unknown>, nextRev: number, nextStatus: DocumentStatus) => {
    if (timer.current) window.clearTimeout(timer.current);
    latest.current = next;
    dirty.current = false;
    rev.current = nextRev;
    setData(next);
    setStatus(nextStatus);
    setConflictRev(null);
    setFieldErrors({});
    setErrorMessage(null);
    setSaveState('saved');
  }, []);

  /** Keeps local changes and writes them over the newer server draft. */
  const overwrite = useCallback(async () => {
    if (conflictRev === null) return false;
    rev.current = conflictRev;
    setConflictRev(null);
    dirty.current = true;
    return save();
  }, [conflictRev, save]);

  /** Forgets the local changes, for example before a navigation that the user confirmed. */
  const discard = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    dirty.current = false;
  }, []);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      currentLocation.pathname !== nextLocation.pathname && (dirty.current || inFlight.current !== null),
  );
  const blockerState = blocker.state;
  const proceed = blocker.proceed;

  useEffect(() => {
    if (blockerState !== 'blocked' || blockedNavigation(saveStateRef.current) === 'ask') return;
    void save().then((saved) => {
      if (saved) proceed?.();
    });
  }, [blockerState, proceed, save]);

  useEffect(() => {
    const documentId = options.documentId;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty.current && !inFlight.current) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (timer.current) window.clearTimeout(timer.current);
      if (saveStateRef.current === 'conflict') return;
      void (inFlight.current ?? Promise.resolve()).then(() => {
        if (dirty.current) void flushDraft(documentId, latest.current, rev.current);
      });
    };
  }, [options.documentId]);

  return {
    data,
    change,
    save,
    replace,
    overwrite,
    rev,
    status,
    setStatus,
    saveState,
    errorMessage,
    fieldErrors,
    setFieldErrors,
    slug,
    setSlug,
    slugError,
    previewPath,
    setPreviewPath,
    savedAt,
    isDirty: () => dirty.current,
    discard,
    /** Set when a navigation waits for the user: the save failed or conflicts. */
    leavePrompt:
      blocker.state === 'blocked' && blockedNavigation(saveState) === 'ask'
        ? {
            stay: () => blocker.reset?.(),
            leave: () => {
              discard();
              blocker.proceed?.();
            },
          }
        : null,
  };
}

export function issuesToErrors(issues: unknown[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const { path, message } = issue as { path?: (string | number)[]; message?: string };
    if (!Array.isArray(path) || !message) continue;
    const key = path.join('.');
    errors[key] ??= message;
  }
  return errors;
}
