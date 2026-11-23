export const ROLES = ['admin', 'editor', 'author'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrateur',
  editor: 'Éditeur',
  author: 'Auteur',
};

export type DocumentAction = 'read' | 'create' | 'update' | 'publish' | 'delete';
export type GlobalAction = 'media.upload' | 'media.delete' | 'users.manage';
export type Action = DocumentAction | GlobalAction;

export type AccessUser = { id: string; role: Role };
export type AccessDocument = { createdBy: string | null };

/** Per collection: who can do an action, and which roles see only their own documents. */
export type AccessOverrides = Partial<Record<DocumentAction, Role[]>> & { ownOnly?: Role[] };

export const DEFAULT_ACCESS: Record<Action, Role[]> = {
  read: ['admin', 'editor', 'author'],
  create: ['admin', 'editor', 'author'],
  update: ['admin', 'editor', 'author'],
  publish: ['admin', 'editor'],
  delete: ['admin', 'editor'],
  'media.upload': ['admin', 'editor', 'author'],
  'media.delete': ['admin', 'editor'],
  'users.manage': ['admin'],
};

export const DEFAULT_OWN_ONLY: Role[] = ['author'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** True when the role sees only the documents it created in this collection. */
export function isOwnOnly(user: AccessUser, overrides?: AccessOverrides): boolean {
  return (overrides?.ownOnly ?? DEFAULT_OWN_ONLY).includes(user.role);
}

/**
 * Checks one action. Document actions take the collection overrides and, for a role
 * limited to its own documents, the document. Without a document, the check answers
 * for the collection as a whole, and the SQL list query adds the owner filter.
 */
export function can(
  user: AccessUser | null | undefined,
  action: Action,
  overrides?: AccessOverrides,
  doc?: AccessDocument,
): boolean {
  if (!user) return false;
  const isDocumentAction = !action.includes('.');
  const roles = (isDocumentAction && overrides?.[action as DocumentAction]) || DEFAULT_ACCESS[action];
  if (!roles.includes(user.role)) return false;
  if (isDocumentAction && action !== 'create' && doc && isOwnOnly(user, overrides)) {
    return doc.createdBy === user.id;
  }
  return true;
}
