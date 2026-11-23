import { createContext, useContext } from 'react';
import type { SerializedSchema } from '../../config';
import type { MediaObject } from '../../fields/types';

export type EditorContextValue = {
  schema: SerializedSchema;
  media: ReadonlyMap<string, MediaObject>;
  rememberMedia: (media: MediaObject) => void;
  /** Validation messages by field path, for example `body.2.caption`. */
  errors: Record<string, string>;
  selectedBlockId: string | null;
  selectBlock: (id: string | null, origin: 'form' | 'preview') => void;
  /** Changes when the draft is replaced from outside (restore, reload). Uncontrolled editors remount on it. */
  epoch: number;
  readOnly: boolean;
};

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor must be used inside the document editor.');
  return value;
}

export function pathKey(path: (string | number)[]): string {
  return path.join('.');
}
