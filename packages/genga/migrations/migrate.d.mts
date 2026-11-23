import type { Sql } from 'postgres';

/** Applies the pending migrations under an advisory lock. Returns the ids applied now. */
export function runMigrations(sql: Sql): Promise<string[]>;
