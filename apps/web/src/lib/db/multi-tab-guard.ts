// Multi-tab detection guard — proportionate mitigation, not a full fix.
//
// pglite.ts opens `new PGlite({ dataDir: "idb://taakify" })` directly.
// @electric-sql/pglite (0.5.4, the installed version) documents that
// concurrent access to the same IndexedDB-backed dataDir from multiple tabs
// is unsupported without `@electric-sql/pglite/worker`'s leader-election
// `PGliteWorker` — two tabs both writing to the same idbfs-backed Postgres
// instance can corrupt it. Two tabs open to the same household is a
// realistic user action (e.g. opening a book in a new tab), so this isn't a
// hypothetical.
//
// A full fix (migrating to PGliteWorker, with one leader tab owning the
// real PGlite instance and every other tab proxying through it) is a
// meaningfully larger rearchitecture than fits this fix round — see the
// final review fix report for why it's being left as a documented
// follow-up rather than attempted here.
//
// What this module does instead: a lightweight BroadcastChannel-based
// "is anyone else here" handshake, used to warn the user rather than
// silently risk corruption. Every tab announces itself on load ("hello")
// and acks any other tab's "hello" it sees; either message flips
// `getMultiTabDetected()` true for both tabs and notifies subscribers
// (same tiny-observable shape as shape.ts's onSyncedChange /
// outbox.ts's onOutboxChange, for consistency with the rest of the sync
// layer). AppShell.tsx surfaces this as a one-time toast, not a blocking
// dialog — the goal is awareness, not preventing a valid (if risky) user
// action.
//
// Deliberately framework-agnostic (no React), matching the rest of the
// sync layer's modules, so it can be unit tested directly.
const CHANNEL_NAME = "taakify-pglite-tabs";

type Message = { type: "hello" | "ack" };

let channel: BroadcastChannel | undefined;
let multiTabDetected = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function markDetected(): void {
  if (multiTabDetected) return;
  multiTabDetected = true;
  notify();
}

export function getMultiTabDetected(): boolean {
  return multiTabDetected;
}

export function onMultiTabChange(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Start the handshake. Idempotent per page load (matching startSync's /
 * startOutboxWorker's contract). A no-op in environments without
 * BroadcastChannel (very old browsers) — the guard is a best-effort
 * mitigation, not a hard requirement, so it degrades silently rather than
 * throwing.
 */
export function startMultiTabGuard(): void {
  if (channel) return;
  if (typeof BroadcastChannel === "undefined") return;

  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<Message>) => {
    if (event.data.type === "hello") {
      // Someone else just opened while we were already here -- ack so they
      // know about us too, and note that we're no longer alone.
      channel?.postMessage({ type: "ack" } satisfies Message);
      markDetected();
    } else if (event.data.type === "ack") {
      // Someone who was already open just confirmed our "hello".
      markDetected();
    }
  };
  channel.postMessage({ type: "hello" } satisfies Message);
}

// For tests only — closes the channel and resets all state so each test
// starts from a clean slate regardless of what a previous test did.
export function __resetMultiTabGuardForTests(): void {
  channel?.close();
  channel = undefined;
  multiTabDetected = false;
  listeners.clear();
}
