// Plain JavaScript on purpose: `bin/genga-migrate.mjs` runs with `node` in the production
// image, where TypeScript sources are not available to Node.
// Migrations are expand-only: add tables, columns and indexes. Never drop or rename in place.

/** @type {{ id: string; sql: string }[]} */
export const MIGRATIONS = [
  {
    id: '0001_init',
    sql: `
CREATE TABLE genga_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL DEFAULT '',
  password_hash text,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'author')),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE UNIQUE INDEX genga_users_email_key ON genga_users (lower(email));

CREATE TABLE genga_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES genga_users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_agent text
);
CREATE INDEX genga_sessions_user_idx ON genga_sessions (user_id);

CREATE TABLE genga_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('setup', 'invite')),
  token_hash text NOT NULL UNIQUE,
  user_id uuid REFERENCES genga_users (id) ON DELETE CASCADE,
  email text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE genga_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hash text NOT NULL UNIQUE,
  key text NOT NULL UNIQUE,
  filename text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL,
  width integer,
  height integer,
  alt text NOT NULL DEFAULT '',
  sizes jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES genga_users (id) ON DELETE SET NULL
);

CREATE TABLE genga_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection text NOT NULL,
  slug text NOT NULL,
  draft jsonb NOT NULL DEFAULT '{}',
  draft_rev integer NOT NULL DEFAULT 1,
  draft_updated_at timestamptz NOT NULL DEFAULT now(),
  draft_updated_by uuid REFERENCES genga_users (id) ON DELETE SET NULL,
  published_version_id uuid,
  published_rev integer,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES genga_users (id) ON DELETE SET NULL,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX genga_documents_slug_key ON genga_documents (collection, slug) WHERE deleted_at IS NULL;
CREATE INDEX genga_documents_collection_idx ON genga_documents (collection, draft_updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE genga_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES genga_documents (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('draft', 'published', 'restored')),
  slug text NOT NULL,
  data jsonb NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES genga_users (id) ON DELETE SET NULL
);
CREATE INDEX genga_versions_document_idx ON genga_versions (document_id, created_at DESC);

ALTER TABLE genga_documents
  ADD CONSTRAINT genga_documents_published_version_fkey
  FOREIGN KEY (published_version_id) REFERENCES genga_versions (id) ON DELETE SET NULL;

CREATE TABLE genga_redirects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection text NOT NULL,
  from_slug text NOT NULL,
  to_slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection, from_slug)
);

CREATE TABLE genga_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES genga_users (id) ON DELETE SET NULL,
  action text NOT NULL,
  collection text,
  document_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'
);
`,
  },
  {
    // Unpublish clears published_at. The slug rule needs to know if a URL was ever live.
    id: '0002_first_published_at',
    sql: `
ALTER TABLE genga_documents ADD COLUMN first_published_at timestamptz;
UPDATE genga_documents d SET first_published_at = COALESCE(d.published_at, v.first_at)
FROM (
  SELECT document_id, min(created_at) AS first_at FROM genga_versions WHERE kind = 'published' GROUP BY document_id
) v
WHERE v.document_id = d.id;
`,
  },
  {
    // Personal access tokens for the MCP server. The database keeps the sha256 of the token only.
    id: '0003_api_tokens',
    sql: `
CREATE TABLE genga_api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES genga_users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['read', 'write', 'publish']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX genga_api_tokens_user_idx ON genga_api_tokens (user_id, created_at DESC);
`,
  },
  {
    // The outbox of publish events. `seq` follows the commit order: writers take an advisory lock first.
    // A delivery row per event and webhook URL holds the retry state.
    id: '0004_events',
    sql: `
CREATE TABLE genga_events (
  seq bigserial PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  type text NOT NULL,
  at timestamptz NOT NULL,
  event jsonb NOT NULL
);
CREATE INDEX genga_events_at_idx ON genga_events (at);

CREATE TABLE genga_webhook_deliveries (
  event_seq bigint NOT NULL REFERENCES genga_events (seq) ON DELETE CASCADE,
  url text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  delivered_at timestamptz,
  failed_at timestamptz,
  last_status integer,
  last_error text,
  PRIMARY KEY (event_seq, url)
);
CREATE INDEX genga_webhook_deliveries_due_idx ON genga_webhook_deliveries (next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
`,
  },
  {
    // Scheduled publish and unpublish. One row per document and action. The runner deletes the row
    // in the transaction that publishes, so a row runs once even with several replicas.
    id: '0005_schedules',
    sql: `
CREATE TABLE genga_schedules (
  document_id uuid NOT NULL REFERENCES genga_documents (id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('publish', 'unpublish')),
  run_at timestamptz NOT NULL,
  created_by uuid REFERENCES genga_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  failed_at timestamptz,
  last_error text,
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (document_id, action)
);
CREATE INDEX genga_schedules_due_idx ON genga_schedules (run_at) WHERE failed_at IS NULL;
`,
  },
  {
    // OAuth 2.1 for the MCP server. A grant is one consent of a user to a client: it is the unit
    // that the admin lists and revokes. The database keeps the sha256 of codes, tokens and secrets only.
    id: '0006_oauth',
    sql: `
CREATE TABLE genga_oauth_clients (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('registered', 'metadata')),
  name text NOT NULL,
  client_uri text,
  redirect_uris text[] NOT NULL,
  auth_method text NOT NULL CHECK (auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
  secret_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  fresh_until timestamptz,
  last_used_at timestamptz
);

CREATE TABLE genga_oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES genga_users (id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES genga_oauth_clients (id) ON DELETE CASCADE,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['read', 'write', 'publish']::text[]),
  resource text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX genga_oauth_grants_user_idx ON genga_oauth_grants (user_id, created_at DESC);

CREATE TABLE genga_oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES genga_oauth_clients (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES genga_users (id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  scopes text[] NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  replayed_at timestamptz,
  grant_id uuid REFERENCES genga_oauth_grants (id) ON DELETE CASCADE
);
CREATE INDEX genga_oauth_codes_expires_idx ON genga_oauth_codes (expires_at);

CREATE TABLE genga_oauth_tokens (
  token_hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES genga_oauth_grants (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX genga_oauth_tokens_grant_idx ON genga_oauth_tokens (grant_id);
CREATE INDEX genga_oauth_tokens_expires_idx ON genga_oauth_tokens (expires_at);
`,
  },
];
