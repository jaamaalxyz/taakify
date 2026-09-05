# Taakify Plan 7: Cover Image Upload & Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users attach a camera/photo cover to any edition that has no
online cover (the "local titles are first-class" goal) — including offline,
where photos queue in the existing outbox and upload on reconnect.

**Architecture:** A two-method storage interface (`put`/`delete`) on the API,
backed by the S3 API (Cloudflare R2 in production, swappable to MinIO or any
S3 store via config per spec §2, and a zero-config filesystem implementation
for local dev so nobody needs R2 to run the app). One new API route
(`POST /api/editions/:id/cover`) accepts a JSON body so it flows through the
existing outbox unchanged — no binary fetch support needed in the replay
path. On the web side, a small image module downscales the photo to a cover
sized JPEG via canvas (keeps the outbox row small), then enqueues through
`enqueue()` with an optimistic `edition.cover_url` write of the data URL
itself, so the cover appears instantly and is later replaced by the real
object URL when Electric syncs the server's update.

**Tech Stack:** `@aws-sdk/client-s3` (Apache-2.0) on the API; Hono route +
existing `requireUser` middleware; React canvas APIs on the web; existing
outbox/Electric sync untouched.

**Spec:** `docs/superpowers/specs/2026-07-16-taakify-bookshelf-design.md`
(§2 Goals "One deliberate exception", §5 Journey 2, §7 V1 "camera cover
photo upload… photos taken offline queue in the outbox", §8 error handling);
gap #4 in `docs/superpowers/plans/2026-09-03-taakify-design-spec-gaps.md`.

## Global Constraints

- **Storage stays behind the interface.** Only `apps/api/src/lib/storage.ts`
  knows which implementation is active. Nothing else in the codebase may
  import `@aws-sdk/client-s3` or touch the filesystem storage directly.
- **No new mirror tables, no new outbox semantics.** The upload replays as a
  plain `POST` with a JSON body — exactly the shape `enqueue()` already
  records. Binary upload (multipart) is deliberately avoided so the outbox
  replay path, its backoff/dead-letter logic, and its 15s timeout all apply
  unchanged.
- **Client-side downscale before enqueue.** A phone photo is 3–8 MB; the
  outbox row must stay small enough to persist comfortably in PGlite. The
  web module reduces to ≤800px wide JPEG (quality 0.8, typically 60–150 KB)
  **before** `enqueue()` sees it. The API still enforces a decoded-size cap
  as defense in depth.
- **Never delete what we don't own.** Replacing a cover only `delete()`s the
  previous object when the old `cover_url` points inside our own storage
  (`STORAGE_PUBLIC_BASE_URL` prefix / dev storage route). Open Library /
  Google Books covers are external URLs and must not be touched.
- **Editions are global (shared catalog).** Any authed member of any
  household may upload a cover for any edition; improving the catalog for
  one's own local title improves it for everyone. This matches the existing
  global `edition` table model — no household scoping on this route beyond
  `requireUser`.
- **Config is env-driven and optional.** With no `STORAGE_*` env vars set,
  the API falls back to filesystem storage under `apps/api/.storage/`
  served by a dev-only GET route, so `pnpm dev` works with zero external
  services. Production sets the S3/R2 vars.
- **Open-source rule:** the S3 client (`@aws-sdk/client-s3`, Apache-2.0)
  talks to R2 over the standard S3 API — the spec's one allowed proprietary
  service, accessed only through the swappable interface.

---

### Task 1: Storage interface + filesystem/dev implementation

**Files:**
- Create: `apps/api/src/lib/storage.ts`
- Test: `apps/api/src/lib/storage.test.ts`
- Modify: `apps/api/.env.example`

**Interfaces:**
```ts
export interface Storage {
  put(key: string, contentType: string, bytes: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
  /** Public URL for a stored object (no signing — bucket is public-read). */
  url(key: string): string;
}
export function getStorage(): Storage;
/** True when a URL was produced by *our* storage (safe to delete). */
export function isOurUrl(url: string): boolean;
```

- [ ] **Step 1: Write the failing tests**

`storage.test.ts` covers, against the filesystem implementation in a temp
dir (`fs.mkdtempSync`):
- `put` then `url` → GET-able file on disk under the right key path, correct
  content type recorded (sidecar `.meta.json` or extension-derived — pick
  one, test it).
- `delete` removes the object; deleting a missing key does not throw
  (idempotent, same contract as outbox replays).
- `url` prefixes keys with the dev public base
  (`/api/storage/`) when no env override is set; with
  `STORAGE_PUBLIC_BASE_URL` set (use `vi.stubEnv`), it prefixes that
  instead, with exactly one `/` at the join.
- `isOurUrl` accepts our dev URLs and our env-base URLs, rejects
  `https://covers.openlibrary.org/...` and arbitrary https URLs.
- Key sanitization: keys containing `..` or leading `/` are rejected with an
  error (filesystem implementation must not be path-traversable).

- [ ] **Step 2: Implement `storage.ts`**

- `getStorage()` memoizes one instance. If `STORAGE_ENDPOINT` **and**
  `STORAGE_BUCKET` are set → S3 implementation (Task 2); otherwise →
  filesystem implementation (this task). Export a `storageKind()` helper
  (`"s3" | "fs"`) for logging/tests.
- Filesystem impl: writes to `STORAGE_FS_DIR ?? path.join(process.cwd(), ".storage")`,
  `mkdir -p` on first use, stores content type in a sibling `<key>.meta.json`.
  Keys are validated (`/^[a-zA-Z0-9/_-]+$/` after the traversal check) so
  they can't escape the root.
- Add `.storage/` to `apps/api/.gitignore`.
- Append to `.env.example` (commented-out block explaining each var and the
  R2/MinIO swap):
  `STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID,
  STORAGE_SECRET_ACCESS_KEY, STORAGE_PUBLIC_BASE_URL, STORAGE_FS_DIR`.

- [ ] **Step 3: Run tests** — `pnpm --filter @taakify/api test`.

---

### Task 2: S3 implementation of the storage interface

**Files:**
- Modify: `apps/api/src/lib/storage.ts`
- Test: extends `apps/api/src/lib/storage.test.ts`

**Notes:** No live R2/MinIO in CI. Test the S3 path the same way the sync
integration test avoids real Electric: mock at the seam. Structure the S3
impl as a thin adapter over an injected `S3ClientLike`
(`{ send(cmd) }`), so tests construct it with a fake client capturing
`PutObjectCommand` / `DeleteObjectCommand` args and asserting bucket, key,
contentType, Body. `getStorage()` builds the real client from env.

- [ ] **Step 1: Failing tests** — fake-client assertions for put/delete
  command shape; `url()` uses `STORAGE_PUBLIC_BASE_URL`; `getStorage()`
  returns the s3 kind when endpoint+bucket are set (stubbed env).
- [ ] **Step 2: Implement** — `@aws-sdk/client-s3` dependency
  (`pnpm --filter @taakify/api add @aws-sdk/client-s3`). Endpoint is passed
  through `forcePathStyle: true` (required by R2 and MinIO alike).
- [ ] **Step 3: Run tests + typecheck.**

---

### Task 3: Upload API route

**Files:**
- Modify: `apps/api/src/routes/editions.ts` (new `POST /:id/cover`)
- Create: `apps/api/src/routes/storage-dev.ts` (dev-only GET)
- Test: `apps/api/src/routes/editions-cover.test.ts`
- Modify: `apps/api/src/app.ts` (mount dev route; look at how `bootstrap.ts`
  tests exercise routes via `app.request` and follow that pattern)

**Interfaces (shared contract addition, `packages/shared/src/contracts.ts`):**
```ts
// POST /api/editions/:id/cover → 200 { cover_url: string }
// body: { data_url: string }  (data:image/jpeg|png|webp;base64,...)
```

- [ ] **Step 1: Write the failing tests** (mock `getStorage()` via
  `vi.mock`, real PGlite/in-memory server Postgres per existing route-test
  pattern — see how `books` route tests seed):
  - Happy path: seeds an edition, POSTs a small valid JPEG data URL →
    storage `put` called with key starting `covers/<editionId>/`, content
    type `image/jpeg`; response `cover_url` equals `storage.url(key)`;
    edition row's `cover_url` updated in Postgres.
  - Replacing an existing **our-storage** cover calls `storage.delete` on
    the old key *after* a successful put; a put failure (mock rejects)
    leaves the old `cover_url` untouched and returns 5xx.
  - Replacing an **external** cover (openlibrary URL) does **not** call
    `delete`.
  - Rejects (400): non-data-url strings, wrong MIME (`image/gif`), empty
    edition id; 404: unknown edition id; 413: decoded byte length >
    `MAX_COVER_BYTES` (export the constant, default 2 MB).
  - Route requires auth (401 without session, per existing middleware
    tests' approach).

- [ ] **Step 2: Implement the route**

  1. `requireUser` (already mounted at router level), parse + validate the
     data URL (regex for
     `^data:(image/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$`), decode,
     check byte cap.
  2. `SELECT cover_url FROM edition WHERE id = $1` → 404 if missing.
  3. `key = covers/${editionId}/${crypto.randomUUID()}.jpg` — UUID key
     means replays after a timeout never collide with the first attempt;
     a dead-lettered duplicate upload just leaves one orphaned object
     (acceptable, documented in a comment; the outbox idempotency-upsert
     pattern doesn't apply to byte uploads).
  4. `storage.put(key, mime, bytes)`.
  5. `UPDATE edition SET cover_url = storage.url(key), updated_at = now()
     WHERE id = $1` — the Electric shape stream carries this to every
     device, which is the whole sync story.
  6. If the previous `cover_url` `isOurUrl` → `storage.delete(oldKey)`
     (best-effort, `.catch(log)`; deletion failure must not fail the
     request).
- [ ] **Step 3: Dev GET route** — `GET /api/storage/*` streams from the
  filesystem impl only (404 when the s3 impl is active — production serves
  objects from R2/MinIO directly). Content type from the sidecar meta.
- [ ] **Step 4: Run tests + typecheck.**

---

### Task 4: Web image module (downscale + data URL)

**Files:**
- Create: `apps/web/src/lib/cover-image.ts`
- Test: `apps/web/src/lib/cover-image.test.ts`

**Interfaces:**
```ts
/** Downscales/compresses a picked photo to a cover-sized JPEG data URL. */
export async function toCoverDataUrl(file: File): Promise<string>;
export const COVER_MAX_WIDTH = 800;
```

- [ ] **Step 1: Failing tests** — jsdom has no real `createImageBitmap`/
  canvas decoding; mock the seam: factor the pixel work behind
  `loadBitmap(file)` + `drawToJpeg(bitmap, width)` (both injectable /
  `vi.mock`able). Assert: files over max width are downscaled to exactly
  `COVER_MAX_WIDTH` preserving aspect ratio; small files keep their
  dimensions; output prefix is `data:image/jpeg;base64,`; non-image files
  and decode failures reject with a friendly `Error` message (routed
  through `friendlyError` by callers).
- [ ] **Step 2: Implement** — `createImageBitmap` → canvas 2D →
  `canvas.toDataURL("image/jpeg", 0.8)`; `URL.revokeObjectURL` cleanup;
  Safari fallback `Image` + object URL when `createImageBitmap` is absent
  (the seam keeps the fallback testable).
- [ ] **Step 3: Run tests.**

---

### Task 5: Repo function — offline-queued upload

**Files:**
- Modify: `apps/web/src/lib/repo/` — new `editions.ts` (or extend an
  existing edition repo module if one exists; check first)
- Test: `apps/web/src/lib/repo/editions.test.ts`

**Interfaces:**
```ts
export async function uploadEditionCover(editionId: string, dataUrl: string): Promise<void>;
```

- [ ] **Step 1: Failing tests** (real in-memory PGlite + mocked
  `outbox.enqueue`, matching `home.test.ts`'s db-mock pattern):
  - Calls `enqueue` with endpoint `/api/editions/${id}/cover`, method
    `POST`, body `{ data_url }`.
  - The optimistic write in the same transaction updates
    `edition.cover_url` to the data URL in the local mirror (assert via
    `db.query`) and touches `["edition", editionId]` so the existing
    `Unsynced` badge picks it up with zero new badge code.
  - Bumps `edition.updated_at` in the optimistic write.
- [ ] **Step 2: Implement** — one `enqueue()` call, optimistic SQL
  `UPDATE edition SET cover_url = $2, updated_at = now() WHERE id = $1`.
  When the server later processes the replay and Electric streams the row
  back, the real object URL overwrites the data URL — note this in a
  comment, it's the intended replacement path (the data URL in the mirror
  is a temporary preview, never uploaded to Electric).
- [ ] **Step 3: Run tests.**

---

### Task 6: Cover upload UI control

**Files:**
- Create: `apps/web/src/components/CoverUpload.tsx`
- Test: `apps/web/src/components/CoverUpload.test.tsx`
- Modify: `apps/web/src/pages/Add.tsx` (manual form) and the BookDetail
  page — render `CoverUpload` for editions with no `cover_url`

**Behavior:**
- Renders a dashed "Add cover photo" tile (matching the cover placeholder
  size/aspect used by `BookCard` / BookDetail) with a camera icon.
- `<input type="file" accept="image/*" capture="environment" hidden>` —
  mobile browsers offer the camera; desktop offers the file picker.
- On pick: `toCoverDataUrl` → optimistic UI (cover appears immediately
  from the optimistic write via the existing `onMirrorChange` re-render
  path) → `uploadEditionCover`. Errors surface via the existing
  `friendlyError` + `toast` pattern; the input resets so a retry can pick
  again.
- On BookDetail, also render the control when a cover exists but came from
  our storage? **No — v1 scope is gap-filling only** (spec: "for books
  with no online cover"). Replacing an existing cover is out of scope; the
  API supports it (delete-old logic) for future use.

- [ ] **Step 1: Failing tests** — file pick calls `toCoverDataUrl` then
  `uploadEditionCover` with the right ids; rejected `toCoverDataUrl` shows
  the error and does not enqueue; control not rendered when
  `edition.cover_url` is non-null.
- [ ] **Step 2: Implement** + wire into Add's manual tab (after edition
  creation — the edition must exist before it can carry a cover, so the
  control appears on the post-add confirmation state where the created
  edition is shown) and BookDetail.
- [ ] **Step 3: Run tests, typecheck, build.**

---

### Task 7: End-to-end verification + docs

- [ ] `pnpm --filter @taakify/web test && pnpm --filter @taakify/api test`,
  both typechecks, web build.
- [ ] Manual pass against `pnpm dev` (filesystem storage): create a book
  with no cover → upload a photo → cover shows immediately; refresh →
  persisted (edition row updated, dev storage GET serves bytes); DevTools
  offline → upload on another book → back online → outbox flushes and the
  cover lands; verify the `Unsynced` badge appears on the edition while
  queued.
- [ ] Update `.env.example` (done in Task 1) and add a short "Cover
  storage" note to the README/ops docs if one documents env vars.
