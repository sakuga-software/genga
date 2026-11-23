# Changelog

All notable changes to the `genga` package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

First public release.

- Collections, fields and blocks defined in code with `defineConfig` and `defineBlock`.
- Postgres storage with expand-only migrations and the `genga-migrate` command.
- Admin for React Router v7: dashboard, collections, document editor with live preview,
  versions, media library, users and invitations.
- Roles `admin`, `editor` and `author`, with overrides per collection.
- Published reads with an in-process cache, slug redirects and a sitemap helper.
- `genga/client`: `RenderBlocks`, `RichText` and `usePreviewData` for any React site.
- Compiled admin stylesheet (`genga/admin.css`): no Tailwind setup in the app.
