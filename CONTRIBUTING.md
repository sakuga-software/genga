# Contributing

Thank you for your help. Open an issue before a large change, so that we can agree on the
approach first.

## Set up

Requirements: Node 22.22 or later, pnpm (the version in `packageManager`), Docker.

```sh
docker run -d --name genga-postgres -p 54329:5432 \
  -e POSTGRES_USER=genga -e POSTGRES_PASSWORD=genga -e POSTGRES_DB=genga postgres:18
pnpm install
pnpm build
```

## Checks

Run these before you open a pull request. CI runs them too.

```sh
pnpm lint        # oxlint
pnpm format      # oxfmt --check (pnpm format:fix to fix)
pnpm typecheck
pnpm test        # vitest, against Postgres
pnpm build
pnpm test:pack   # packs the packages, installs the tarballs in copies of the examples, builds them
pnpm test:e2e    # the Next.js example against the Genga server, with Playwright (needs E2E_DATABASE_URL)
```

The tests of the S3 adapter run against MinIO when `GENGA_TEST_S3_ENDPOINT` is set (CI sets it):

```sh
docker run -d --name genga-minio -p 59000:9000 \
  -e MINIO_ROOT_USER=genga -e MINIO_ROOT_PASSWORD=genga-minio-test bitnamilegacy/minio:2025.7.23-debian-12-r5
GENGA_TEST_S3_ENDPOINT=http://localhost:59000 GENGA_TEST_S3_ACCESS_KEY=genga \
  GENGA_TEST_S3_SECRET_KEY=genga-minio-test pnpm test
```

The tests create and empty the `genga_test` and `genga_server_test` databases. To use another server, set
`GENGA_TEST_ADMIN_URL` (a database that can create databases) and `GENGA_TEST_DATABASE_URL`.
`pnpm test:pack` also runs the migrations if `DATABASE_URL` is set. It uses the React Router 8 of the
example. `pnpm test:pack --react-router=7` installs React Router 7 and TypeScript 6 in the copy. CI runs both.
`pnpm test:e2e` deletes all content of the database of `E2E_DATABASE_URL` (its name ends in `_e2e` or `_test`, for example `genga_e2e`), and needs
`pnpm build` and two browsers of Playwright (`pnpm --filter genga-example-next exec playwright install chromium webkit`).

## The headless server

```sh
docker build -f apps/server/Dockerfile -t genga .
GENGA_SECRET="$(openssl rand -base64 48)" GENGA_IMAGE=genga \
  docker compose -f apps/server/docker-compose.example.yml up
```

The server tests (`apps/server/test`) call the public API handler directly, against Postgres.

## Conventions

- Commit subjects follow Conventional Commits: `feat:`, `fix:`, `docs:`, `ci:`, `chore:`.
- Write a comment only when the code cannot say it: a risk, a reason, a public contract.
- The admin must stay accessible (WCAG 2.2 AA): keyboard access, visible focus, labels,
  live regions. Use only open-source dependencies.
- Migrations are expand-only. Add a new entry to `packages/genga/migrations/migrations.mjs`;
  never change one that shipped.
- Add a line to `CHANGELOG.md` under "Unreleased" for each user-visible change.

## CI and pull requests from forks

CI runs on GitHub-hosted runners, which are free for a public repository. A pull request from a
fork runs on a fresh machine of GitHub, with no secret of this repository. The repository
settings also require approval before workflows run for outside contributors.

Do not move these workflows to self-hosted runners: a workflow there runs the code of the pull
request on our own machines.

## Release

1. Update the version in every `packages/*/package.json`: all packages share one version. Move
   the "Unreleased" notes of `CHANGELOG.md` under the new version. Merge to `main`.
2. On GitHub, « Draft a new release ». Create the tag `vX.Y.Z` on the merge commit, then
   « Generate release notes » and « Publish release ».
3. The release starts `release-npm.yml`: the checks of CI on the tag, the tarball, then the
   publication. The publication waits until a person approves the environment `npm`. The tag also
   starts `docker.yml`, which pushes the image to GHCR for `linux/amd64` and `linux/arm64`, with
   provenance and SBOM attestations.

A tag pushed alone publishes nothing on npm. A run from « Run workflow » packs and checks, and
publishes nothing, also on a tag. To try a failed release again, use « Re-run jobs » on its run:
a version that npm already has is skipped.

No npm token exists. npm trusts the OIDC token of `release-npm.yml`, in the environment `npm`,
as the trusted publisher of each package. To set it again, a person who can publish the package
runs, with npm 11.5.1 or later:

```sh
npm trust github genga --file release-npm.yml \
  --repository sakuga-software/genga --environment npm --allow-publish
npm trust github @genga-cms/next --file release-npm.yml \
  --repository sakuga-software/genga --environment npm --allow-publish
```

WARNING: set the trusted publisher of a new package before its first release. Without it, the
publication of that package fails. If npm refuses a trusted publisher for a package that it does
not have yet, the owner of the `@genga-cms` organization publishes a first version by hand.
