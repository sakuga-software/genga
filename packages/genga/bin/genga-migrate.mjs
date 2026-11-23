#!/usr/bin/env node
import postgres from 'postgres';
import { runMigrations } from '../migrations/migrate.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('[genga] DATABASE_URL is not set: the CMS is off, no migration to run.');
  process.exit(0);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const applied = await runMigrations(sql);
  console.log(applied.length ? `[genga] Migrations applied: ${applied.join(', ')}` : '[genga] Database is up to date.');
} catch (error) {
  console.error('[genga] Migration failed:', error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
