# On-site editing (design)

Status: design for a future feature. No code exists. Related: [Framework adapters](./adapters.md),
[Preview bridge](./preview-bridge.md), [GNG-1](https://linear.app/sakuga-software/issue/GNG-1).

Today an editor changes content in a form, and the site page shows the result in an iframe.
On-site editing lets the editor change the content on the page itself:

- click a title or a paragraph and type in place,
- edit rich text in place, with a small toolbar,
- add, move, duplicate and delete blocks from a block toolbar,
- later, see who else edits the page, and edit together in real time.

Every change goes to the same draft as the form. Publish, versions and access rules do not
change.

## 1. Decisions

| #   | Decision                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | On-site editing runs **inside the admin editor**, as a mode of the preview pane. The page stays in an iframe; the admin keeps the session, the draft and the saves.            |
| E2  | An **overlay script** (`genga/edit`) runs in the page in preview mode only. It never holds a credential and never calls the admin API. It talks to the admin by `postMessage`. |
| E3  | Renderers emit **field annotations** (`data-genga-field`) with stable paths, in preview only. Custom components use small helpers of each adapter.                             |
| E4  | The overlay edits in a **floating editor** placed over the annotated element. It never mutates DOM that the framework owns.                                                    |
| E5  | Phase 1 keeps the **`draftRev` compare-and-set** and the 409 flow of today. One editor per document.                                                                           |
| E6  | Phase 2 adds **presence** over **SSE plus POST**, fanned out in process and through **Postgres `LISTEN/NOTIFY`**.                                                              |
| E7  | Phase 3 uses a **CRDT (Yjs)** for collaborative editing, with the JSON draft kept as a materialized snapshot. Operational transform is rejected.                               |
| E8  | No editing code and no annotation reach a public response.                                                                                                                     |

## 2. Architecture options

### Where the editing UI runs

| Option                                                          | For                                                                                                                           | Against                                                                                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Overlay in the framed page, admin as the writer** (chosen) | Reuses the session, CSRF check, autosave and conflict UI of the admin. Works in both modes. Credentials never enter the site. | Needs annotations in the renderers. Two windows to keep in sync.                                                                              |
| B. Overlay in a top-level site page that calls the admin API    | No iframe; the page looks like the public page.                                                                               | Remote mode needs cross-origin writes with credentials (CORS with cookies, third-party cookie rules). The site origin would hold write power. |
| C. The admin re-renders the page itself                         | Full control of the DOM.                                                                                                      | Impossible for Vue, Svelte and Astro components, and wrong for React: the page is the site code, not the admin.                               |
| D. A browser extension                                          | No change to the site.                                                                                                        | Install friction, store review, one build per browser.                                                                                        |

Option A keeps one rule from the preview bridge: **the frame reads, the admin writes.** A full
width "on-site" layout of the preview pane hides the form, so the editor sees only the page.
The form stays one click away: it is the accessible fallback and the place for fields that
have no visible element (SEO description, slug, tags).

Option B can come later for embedded mode only, where the page and the admin share an origin.
It is out of scope here.

### How the overlay reaches the page

The adapter loads `genga/edit` only when the server has checked a preview token **and** the
URL holds `genga-edit=1`. The editor adds this parameter in on-site mode. The script is part
of the site bundle (a dynamic `import()` in the preview component of each adapter), so the
site CSP needs no new script origin, and the public bundle does not load it.

```mermaid
sequenceDiagram
  participant A as Admin editor (writer)
  participant F as Site page in iframe (overlay)
  participant S as Genga server
  A->>F: load ?genga-preview&genga-token&genga-edit=1
  F->>A: genga:ready
  A->>F: genga:draft (data, draftRev)
  F->>A: genga:edit (path, value)
  A->>A: apply to the form state, validate
  A->>F: genga:draft (live level)
  A->>S: PUT draft (draftRev) after 1.5 s
  S-->>A: new draftRev
  A->>F: genga:saved (refresh level)
```

## 3. Field annotations

### Paths

A path names one value in the document data. Segments are field names, and the `_id` of an
array item or a block. An index is never used, because a move changes it.

```
title
body/8d2f…/title
body/8d2f…/items/c71a…/label
seo/description
```

Grammar: `segment ("/" segment)*`, where a segment is a field name (`[a-zA-Z][a-zA-Z0-9_]*`) or
an item id. The admin resolves a path against the schema. A path that does not resolve, or
that resolves to a field that the user cannot change, is ignored.

### Attributes

| Attribute               | On                                         | Value                                                       |
| ----------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `data-genga-field`      | the element that shows a value             | its path                                                    |
| `data-genga-field-type` | same element                               | `text`, `textarea`, `richText`, `media`, `number`, `select` |
| `data-genga-block-id`   | block wrapper                              | as today                                                    |
| `data-genga-list`       | the wrapper of a `blocks` or `array` field | its path; the target of insert and move                     |

The renderers emit these attributes only when `preview` is true. A public response has none.

### Helpers per framework

`<Blocks>` annotates block wrappers by itself. Fields inside a block need the block author:

| Framework | Helper                                                                |
| --------- | --------------------------------------------------------------------- |
| React     | `const field = useGengaField(); <h2 {...field('title')}>{title}</h2>` |
| Vue       | `<h2 v-genga-field="'title'">{{ title }}</h2>`                        |
| Svelte    | `<h2 use:gengaField={'title'}>{title}</h2>`                           |
| Astro     | `<h2 {...gengaField(Astro.props, 'title')}>{title}</h2>`              |
| HTML      | `data-genga-field="body/8d2f…/title"` by hand                         |

The helper knows the block context (`_id`, list path), so the author writes only the field
name. Outside preview, the helper returns no attribute. A field without an annotation stays
editable in the form; the overlay simply does not offer it.

## 4. The overlay

### Editing a value

1. The overlay finds annotated elements and draws an outline on hover and on focus.
2. A click, or `Enter` on the focused outline, opens a **floating editor**: an element in a
   shadow root, placed over the target, with the same box and the computed font, size, line
   height and color of the target.
3. The target gets `visibility: hidden` while the editor is open. Nothing else in the
   framework DOM changes.
4. Each change sends `genga:edit { path, value }` to the admin, at most once per animation
   frame. The admin applies it, validates it, and sends `genga:draft` back as today.
5. `Escape` restores the value from before the editor opened. `Enter` (plain text) or a
   click outside closes the editor and keeps the value.

Why a floating editor and not `contenteditable` on the target: React, Vue and Svelte own their
DOM. A direct edit fights the next render, and an Astro refresh replaces the HTML. The
floating editor leaves the framework DOM alone, and the next render shows the value that the
admin confirmed.

### Rich text

The floating editor of a `richText` field is a TipTap editor with the extensions of the admin
(the same schema, so the sanitizer accepts its output). It sends the TipTap JSON. The toolbar
is the one of the admin, in the shadow root. The overlay loads TipTap lazily, on the first
rich text edit.

### Blocks

A block toolbar appears on the focused block: move up, move down, duplicate, delete, and
"insert after". The overlay sends intents, never data:

| Message                 | Payload                                           |
| ----------------------- | ------------------------------------------------- |
| `genga:block:insert`    | `listPath`, `afterId` (or null), `type`           |
| `genga:block:move`      | `listPath`, `id`, `afterId`                       |
| `genga:block:duplicate` | `listPath`, `id`                                  |
| `genga:block:delete`    | `listPath`, `id`                                  |
| `genga:block:open`      | `id`: opens the form of the block in a side panel |

The admin applies the intent with the same code as the form (allowed types, `maxItems`, new
`_id`), then sends the new draft. Insert opens the block picker of the admin, so the overlay
needs no copy of the schema. A block field without a visible element (an image `alt`, a link
URL) is edited in the side panel.

### Media

A click on an annotated image opens the media picker of the admin, as a dialog over the
iframe. The overlay sends `genga:media:pick { path }`; the admin writes the chosen media id.

## 5. Phases

### Phase 1: inline editing, one user

Scope: everything in sections 3 and 4, for one editor at a time.

- **Saves.** The admin keeps its autosave: 1.5 s after the last change, `PUT draft` with
  `draftRev`. A 409 shows the existing conflict dialog (reload or keep mine).
- **Soft lock.** When a document is open in the editor, the admin writes a heartbeat
  (`genga_document_editors(document_id, user_id, seen_at)`, every 20 s). A second editor sees
  "Marie edits this page" and can still continue. This is advice, not a lock: the `draftRev`
  check stays the safety net.
- **Undo.** `Ctrl+Z` in the floating editor undoes inside the field. The admin keeps its own
  history for block intents.

Acceptance:

- In the four adapter examples, an editor changes a title, a paragraph of rich text, and the
  order of two blocks on the page, then publishes.
- With the overlay open, a public request of the same URL without a token has no
  `data-genga-*` attribute and loads no `genga/edit` chunk.
- The keyboard path works end to end (section 7).
- A conflict between two tabs shows the 409 dialog and loses no data.

### Phase 2: presence

Scope: who is on the document, and which field each person edits. No merging of content.

- **Transport.** Server-Sent Events plus POST:
  - `GET <adminPath>/api/documents/:id/events` (SSE) streams presence and save notices.
  - `POST <adminPath>/api/documents/:id/presence` sends the local state (focused path,
    selection) at most twice per second.
  - Both need the session and the `read` permission on the document. The POST passes the
    Origin check.
- **Why SSE and not WebSocket.** Adapters mount Genga as a Fetch handler
  (`(Request) => Response`). Next.js, Astro and SvelteKit route handlers cannot upgrade a
  connection to a WebSocket, but they can return a streamed `Response`. SSE also passes
  through every proxy that the adapters document. Each tab holds one SSE connection, so the
  HTTP/1.1 limit of six connections per origin is not a problem. Proxies must not buffer the
  stream: the handler sends `X-Accel-Buffering: no` and a comment line every 15 s.
- **Fan-out.** Embedded Genga is one process, so an in-process map of subscribers is enough.
  The design still goes through Postgres `LISTEN/NOTIFY` on one channel (`genga_doc`), for
  three reasons: the server image and an embedded site can share one database, MCP writes
  must notify the editors, and it prepares more than one replica. `NOTIFY` payloads stay
  small (document id, `draftRev`, user id, type), well below the 8000-byte limit. Presence
  itself stays in memory with a 30 s expiry and does not go through Postgres.
- **In the page.** The admin holds the SSE connection, and relays presence to the frame with
  `genga:presence { users: [{ id, name, color, path }] }`. The overlay draws a colored outline
  and a name label on the fields that other people edit. The frame still holds no credential.
- **Save notices.** When another person saves, the admin gets `draft.saved { draftRev, by }`.
  If the local draft has no unsaved change, it reloads the draft. If it has some, it shows
  "Marie saved a newer version" before the 409 can happen.

Acceptance: two browsers on the same document see each other within 2 s, see the field that
the other edits, and get a notice on each save of the other.

### Phase 3: real-time collaboration

Scope: two or more people type in the same document at the same time, and the changes merge
without a conflict dialog.

**Data model: Yjs.**

| Data                                           | Yjs type                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| The document                                   | one `Y.Doc` per document draft                                     |
| Plain fields                                   | `Y.Map` of field name to value (`text` and `textarea` as `Y.Text`) |
| `richText`                                     | `Y.XmlFragment`, bound to TipTap with the Collaboration extension  |
| `blocks`, `array`                              | `Y.Array` of `Y.Map`, each with its `_id`                          |
| `group`                                        | nested `Y.Map`                                                     |
| `media`, `select`, `number`, `boolean`, `date` | a value in the `Y.Map` (last writer wins)                          |

**Why a CRDT and not operational transform.**

| Option                              | For                                                                       | Against                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Yjs (CRDT)** (chosen)             | Mature, TipTap support, merges in any order, works offline for short gaps | Binary updates to validate, memory per open document, a new dependency                        |
| Operational transform (ShareDB)     | Small documents, server authority                                         | One transform per data type, JSON plus ProseMirror needs two systems, a less active ecosystem |
| `prosemirror-collab` + field locks  | Simple, central authority                                                 | Rich text only; blocks and plain fields still need locks                                      |
| `draftRev` + field-level locks only | No new dependency                                                         | Two people cannot type in the same rich text field; this is phase 1 and 2, not collaboration  |

**Server.**

- The server keeps one `Y.Doc` in memory per open document, created from the JSON draft on
  the first connection.
- Updates arrive by POST (`<adminPath>/api/documents/:id/sync`) and leave by the SSE stream of
  phase 2. This is the Yjs sync protocol on SSE plus POST, with a small custom provider. A
  WebSocket provider (`y-websocket`, Hocuspocus) can be an option of the server image later,
  where a WebSocket upgrade is possible.
- Each update is appended to `genga_draft_updates(document_id, seq, update, user_id, at)`. A
  compaction job merges them into a snapshot when the document has no editor for 5 minutes.
- **The JSON draft stays the source for everything else.** At most once per second, the server
  writes the materialized JSON to `genga_documents.draft` and increments `draftRev`. Preview,
  publish, versions, MCP and the public API read JSON as today. Publish first flushes the
  pending updates.
- **MCP writes during a session.** An MCP `save_draft` on a document with an open `Y.Doc`
  goes into the `Y.Doc` as a transaction, not around it.

**Validation.** A merge can produce a value that a single writer could not: two inserts can
pass `maxItems`, for example. The server checks the materialized JSON with the draft rules
(tolerant) and the sanitizer before each snapshot. It does not reject updates: it marks
problems in the editor, as the form does today, and publish keeps its strict validation. The
server rejects an update that is larger than 1 MB or that changes a field outside the schema.

**In the page.** The admin holds the `Y.Doc` provider. The frame keeps `genga:draft` as its
input, and gets remote cursors in rich text by `genga:presence`. The floating rich text
editor in the frame binds to a sub-document that the admin relays by `postMessage`
(`genga:y:update`, binary). This keeps credentials in the admin.

Acceptance: two people type in the same rich text field and in two different blocks at the
same time for one minute; both end with the same content; publish gives that content; the
version history shows one version per publish, not per keystroke.

## 6. Security

- **Who can edit.** Only a signed-in user with `update` on the document. The token in the
  frame URL gives read access to one draft, never write access. All writes go through the
  admin API, with the session, the Origin check and the access rules of today (an `author`
  changes only its own documents).
- **No editing code on public responses.** The adapter loads `genga/edit` only after a valid
  preview token and `genga-edit=1`. Preview responses are `private, no-store`. An e2e test
  checks a public response for `data-genga-` attributes and for the edit chunk.
- **Messages.** As in the preview bridge: exact target origins, checks of `event.origin` and
  `event.source`, and the document id. The admin treats every `genga:edit` value as untrusted
  input: it validates it with the field schema, and sanitizes rich text, before it enters the
  draft.
- **CSP.** The overlay is first-party code of the site bundle. Its styles are in a stylesheet
  file served with the chunk, inside a shadow root, so the site needs no `'unsafe-inline'`
  style source. The admin keeps `frame-src` limited to the preview origins.
- **Clickjacking.** The site allows framing only by the admin origin on preview responses
  (`frame-ancestors`), as the preview bridge already requires.
- **Phase 2 and 3.** SSE and sync endpoints need the session; the server checks `read` at
  connection and `update` on each POST. A disabled user loses its streams at once.
  `NOTIFY` payloads carry ids only, never content.

## 7. Accessibility

On-site editing must meet WCAG 2.2 AA, like the admin.

- **Keyboard.** An "Edit on page" mode adds one focusable outline per annotated field, in
  document order. `Tab` moves between them, `Enter` opens the floating editor, `Escape`
  closes it and returns focus to the outline. Page links do not navigate in this mode.
- **No drag only.** Block moves have buttons and shortcuts (`Alt+ArrowUp`, `Alt+ArrowDown`).
  Drag can come later as an extra (WCAG 2.5.7).
- **Names and roles.** The floating editor is a `textbox` (or the TipTap editor with
  `aria-multiline`) named by the field label from the schema, for example "Title, block
  Hero". The block toolbar is a `toolbar` with arrow-key navigation.
- **Announcements.** A live region in the admin announces saves, conflicts and, in phase 2,
  "Marie edits the title". Announcements are polite and grouped, so typing by another person
  does not flood a screen reader.
- **Focus and contrast.** Outlines have 3:1 contrast against the page and do not rely on
  color alone (a label shows the field name). The overlay respects `prefers-reduced-motion`.
- **Equivalent path.** Every action of the overlay exists in the form, which stays one click
  away.

## 8. Reuse of the preview bridge

| Existing                      | Reused for                                       |
| ----------------------------- | ------------------------------------------------ |
| `genga:ready`, `genga:hello`  | Handshake of the overlay                         |
| `genga:draft`                 | The confirmed value after each edit              |
| `genga:saved` (adapters spec) | Refresh of server-rendered blocks                |
| `genga:select`, `genga:focus` | Selection of a block on the page and in the form |
| `data-genga-block-id`         | Block toolbar target                             |
| Origin rules of the bridge    | All new messages                                 |

New messages: `genga:edit`, `genga:block:*`, `genga:media:pick`, `genga:presence`,
`genga:y:update`. They join the `PreviewMessage` type of the core, so that every adapter
shares one definition.

## 9. Out of scope

- Editing on a top-level page without the admin (option B).
- Comments, suggestions and tracked changes.
- Editing of fields that have no visible element, except through the side panel.
- Offline editing beyond the short gaps that Yjs merges.
- More than one replica for the Yjs server in phase 3. `LISTEN/NOTIFY` carries presence and
  save notices across replicas, but the in-memory `Y.Doc` needs one owner per document.

## 10. Open questions

1. Is the soft lock of phase 1 enough for the owner's teams, or is a hard lock per document
   wanted before phase 3?
2. Phase 3 adds Yjs and its TipTap binding to the admin bundle (size to measure in the prototype).
   Load it only when a second person joins?
3. Should MCP clients appear in presence (as "Claude, via MCP")?
