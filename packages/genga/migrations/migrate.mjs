import { MIGRATIONS } from './migrations.mjs';

// Any constant works: all Genga processes must use the same one.
const LOCK_ID = 7_310_442_118;

/**
 * Applies the pending migrations in one transaction, under an advisory lock.
 * Two processes that start together apply each migration once.
 * @param {import('postgres').Sql} sql
 * @returns {Promise<string[]>} The ids of the migrations applied now.
 */
export async function runMigrations(sql) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`CREATE TABLE IF NOT EXISTS genga_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const rows = await tx`SELECT id FROM genga_migrations`;
    const done = new Set(rows.map((row) => row.id));
    const applied = [];
    for (const migration of MIGRATIONS) {
      if (done.has(migration.id)) continue;
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO genga_migrations (id) VALUES (${migration.id})`;
      applied.push(migration.id);
    }
    return applied;
  });
}
