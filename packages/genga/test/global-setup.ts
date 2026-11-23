import postgres from 'postgres';

export const ADMIN_URL = process.env.GENGA_TEST_ADMIN_URL ?? 'postgres://genga:genga@localhost:54329/genga';
export const TEST_URL = process.env.GENGA_TEST_DATABASE_URL ?? 'postgres://genga:genga@localhost:54329/genga_test';

/** Creates the test database if it is missing, then empties it. */
export default async function setup() {
  const name = new URL(TEST_URL).pathname.slice(1);
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (!exists) await admin.unsafe(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await admin.end();
  }
  const test = postgres(TEST_URL, { max: 1, onnotice: () => {} });
  try {
    await test.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await test.end();
  }
}
