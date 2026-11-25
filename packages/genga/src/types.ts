import type { ApiScope, Role } from './access';
import type { MediaObject } from './fields/types';

/**
 * - `draft`: never published.
 * - `published`: the published version matches the draft.
 * - `changed`: published, and the draft has later changes.
 */
export type DocumentStatus = 'draft' | 'published' | 'changed';

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
};

export type DocumentSummary = {
  id: string;
  collection: string;
  slug: string;
  title: string;
  status: DocumentStatus;
  updatedAt: string;
  publishedAt: string | null;
  createdBy: string | null;
  authorName: string | null;
};

/** Where the editor loads the preview. `origin` is null when the preview has the origin of the admin. */
export type PreviewTarget = { url: string; origin: string | null };

export type AdminDocument = DocumentSummary & {
  draft: Record<string, unknown>;
  draftRev: number;
  /**
   * The slug of the URL that the last publish made live, also after an unpublish.
   * After the first publish, a new slug in the draft waits for the next publish.
   */
  publishedSlug: string | null;
  previewPath: string;
  /** The URL of the preview frame, or null when the collection has no preview. */
  preview: PreviewTarget | null;
  media: Record<string, MediaObject>;
  canPublish: boolean;
  canDelete: boolean;
};

export type VersionSummary = {
  id: string;
  kind: 'draft' | 'published' | 'restored';
  note: string | null;
  createdAt: string;
  authorName: string | null;
  isPublished: boolean;
};

/** A published document, or a draft in preview mode, with media objects in place of ids. */
export type PublishedDocument<T = Record<string, unknown>> = {
  id: string;
  collection: string;
  slug: string;
  versionId: string | null;
  publishedAt: string | null;
  data: T;
};

export type MediaItem = MediaObject & {
  size: number;
  createdAt: string;
};

export type PreviewMessage =
  | { type: 'genga:ready'; documentId: string }
  | { type: 'genga:hello'; documentId: string }
  | { type: 'genga:draft'; documentId: string; data: Record<string, unknown> }
  | { type: 'genga:select'; documentId: string; blockId: string; index: number }
  | { type: 'genga:focus'; documentId: string; blockId: string | null }
  /** The autosave stored the draft. Server-rendered pages refresh. */
  | { type: 'genga:saved'; documentId: string; draftRev: number }
  /** A fresh preview token, before the current one expires (preview on another origin). */
  | { type: 'genga:token'; documentId: string; token: string };

export type CollectionNav = {
  name: string;
  label: string;
  labelSingular: string;
  canCreate: boolean;
};

export type AppLayoutData = {
  /** Base path of the admin, for example `/admin`. */
  adminPath: string;
  /** The link "Voir le site", or null to hide it. */
  siteLink: string | null;
  user: PublicUser;
  collections: CollectionNav[];
  canManageUsers: boolean;
  canDeleteMedia: boolean;
};

export type DashboardData = {
  counts: Record<string, Record<DocumentStatus, number>>;
  recent: DocumentSummary[];
  mediaCount: number;
};

export type CollectionPageData = {
  collection: CollectionNav;
  documents: DocumentSummary[];
  search: string;
  status: DocumentStatus | 'all';
};

export type DocumentPageData = {
  document: AdminDocument;
  versions: VersionSummary[];
  schema: import('./config').SerializedSchema;
};

export type MediaPageData = { media: MediaItem[]; canDelete: boolean; canUpload: boolean };

export type UsersPageData = { users: PublicUser[]; currentUserId: string };

export type LoginPageData = { needsSetup: boolean; next: string; adminPath: string };

export type SetupPageData = { adminPath: string } & (
  | { valid: true; kind: 'setup' | 'invite'; email: string | null; name: string; token: string }
  | { valid: false }
);

export type FormResult = { error: string } | null;

/** An API token as the admin lists it. The clear token shows only once, at creation. */
export type ApiTokenItem = {
  id: string;
  name: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  user: { id: string; email: string; name: string };
};

export type TokensPageData = {
  tokens: ApiTokenItem[];
  /** The tokens of every user, for a user manager. Null for the other roles. */
  allTokens: ApiTokenItem[] | null;
  currentUserId: string;
  /** True when the role of the user can publish in at least one collection. */
  canPublish: boolean;
};
