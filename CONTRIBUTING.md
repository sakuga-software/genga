# Contributing

Thank you for your help. Open an issue before a large change, so that we can agree on the
approach first.

## Set up

Requirements: Node 22.12 or later, pnpm (the version in `packageManager`), Docker.

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
pnpm test:pack   # packs genga, installs the tarball in a copy of the example, builds and serves it
```

The tests create and empty the `genga_test` and `genga_server_test` databases. To use another server, set
`GENGA_TEST_ADMIN_URL` (a database that can create databases) and `GENGA_TEST_DATABASE_URL`.
`pnpm test:pack` also runs the migrations if `DATABASE_URL` is set.

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

CI runs on self-hosted runners. A workflow on a self-hosted runner runs the code of the pull
request on our machines, so the jobs skip pull requests from forks:

```yaml
if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
```

This guard is not enough alone: a pull request can change the workflow file itself. The
repository settings must also require approval before workflows run for outside
contributors. A maintainer runs the checks of a fork pull request after a review, for
example by pushing the branch to this repository.

## Release

1. Update the version in `packages/genga/package.json` and move the "Unreleased" notes of
   `CHANGELOG.md` under the new version. Merge to `main`.
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
as the trusted publisher of `genga`. To set it again, a person who can publish `genga` runs, with
npm 11.5.1 or later:

```sh
npm trust github genga --file release-npm.yml \
  --repository sakuga-software/genga --environment npm --allow-publish
```
