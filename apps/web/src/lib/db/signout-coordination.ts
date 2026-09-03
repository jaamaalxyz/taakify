// Cross-tab sign-out coordination (issue #17 follow-up).
//
// With the PGliteWorker migration, `db` in every tab is a proxy to whichever
// tab's worker won the Web Locks election and actually holds the
// IndexedDB-backed files open. `performSignOut`'s `db.close()` + 
// `indexedDB.deleteDatabase()` sequence therefore has a hole whenever two or
// more tabs are open: closing THIS tab's proxy does nothing about the other
// tabs' connections, the delete gets blocked (verified live: the previous
// household's mirror survived on disk), and the abandoned delete request
// never completes even after the other tabs close. Worse, if this tab is a
// follower, its own worker can win the election the moment the leader
// closes -- reopening the exact database we're trying to delete.
//
// This module closes that hole with a two-phase BroadcastChannel protocol:
//
//   1. The signing-out tab broadcasts "prepare". Every other tab closes (and
//      terminates) its own worker, acks, and then WAITS -- crucially without
//      reloading, because the reload's fresh page eagerly boots a new
//      PGliteWorker that would re-open `/pglite/taakify` before the delete
//      below has finished.
//   2. Once acks settle, the signing-out tab closes its own worker, deletes
//      the IndexedDB database, and broadcasts "done". Only then do the other
//      tabs reload (to the sign-in screen -- the session was invalidated
//      server-side anyway). A safety timeout reloads them regardless, so a
//      crashed/closed signing-out tab can't leave them frozen forever.
//
// Deliberately framework-agnostic (no React), matching the rest of the sync
// layer's modules, so it can be unit tested directly against a real
// BroadcastChannel (jsdom provides one) the same way the old multi-tab-guard
// tests did.
const CHANNEL_NAME = "taakify-signout";

// BroadcastChannel delivers a posted message to every OTHER channel *object*
// of the same name in the same page, not just objects in other tabs -- and
// every tab (including the one about to sign out) runs both halves of this
// protocol: `startSignOutCoordination`'s follower listener (via AppShell's
// useSignOutCoordination) AND, when it's the one signing out,
// requestOtherTabsToClose/announceSignOutComplete. Without tagging messages
// with a per-page origin id, the signing-out tab's own follower would react
// to its own "prepare" (redundant but harmless) and its own "done" (NOT
// harmless: it would `location.reload()` immediately, racing -- and
// potentially aborting -- performSignOut's own
// `authClient.signOut().finally(() => location.reload())` a couple lines
// later, which could leave the server-side session un-invalidated even
// though local data was already wiped). Code review finding, issue #17.
const SELF_ID = crypto.randomUUID();

type Message =
  | { type: "prepare"; senderId: string }
  | { type: "closed"; senderId: string }
  | { type: "done"; senderId: string };

// How long "prepare" waits for other tabs' "closed" acks to stop arriving
// before proceeding. BroadcastChannel has no way to ask "who is listening",
// so this is a settle window, not an exact count: same-origin acks arrive
// within tens of milliseconds, so 1s is already generous, and a tab that
// can't ack in time isn't going to release its connection anyway (then
// deleteIndexedDb's own blocked handling takes over, same as before this
// module existed). This delay is paid on EVERY sign-out, including the
// common single-tab one -- keep it short. Exported for tests.
export const ACK_SETTLE_MS = 1000;

// How long a tab that has closed its worker waits for "done" before giving
// up and reloading anyway. Generous: the signing-out tab still has to run a
// best-effort outbox flush (up to 2s) plus the delete; anything past 8s
// means that tab died mid-sign-out, and reloading is safe by then (the
// delete either completed or was blocked-and-abandoned -- nothing this tab
// can still do about it).
const DONE_TIMEOUT_MS = 8000;

let channel: BroadcastChannel | undefined;
// The follower's post-close "wait for done" channel + safety timer, tracked
// at module scope purely so __resetSignOutCoordinationForTests can tear
// them down too -- otherwise a test that exercises the follower path leaves
// this channel/timer running into later tests in the same file, which then
// see a stray reload() when an unrelated later test broadcasts "done".
let pendingDoneChannel: BroadcastChannel | undefined;
let pendingSafetyTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Phase 1 (signing-out tab): tell every other tab to close its database
 * connection NOW and wait until they've settled. Returns once acks have
 * stopped arriving (or ACK_SETTLE_MS elapsed). Idempotent-safe: called once
 * per sign-out, from performSignOut, before this tab closes its own
 * connection. Must be called BEFORE `closeLocalDatabase()` on this tab --
 * otherwise this tab's own worker could win the leader election left vacant
 * by another tab closing and re-open the database we're about to delete.
 */
export function requestOtherTabsToClose(): Promise<void> {
  // A tab with no other listeners settles immediately; only the ACK_SETTLE
  // window distinguishes "no one else" from "they haven't answered yet".
  return new Promise((resolve) => {
    if (typeof BroadcastChannel === "undefined") {
      // No BroadcastChannel (very old browsers): no coordination possible;
      // behave like the pre-coordination flow rather than blocking sign-out.
      resolve();
      return;
    }
    const ch = new BroadcastChannel(CHANNEL_NAME);
    let acks = 0;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(settleTimer);
      clearTimeout(hardTimer);
      ch.close();
      void acks;
      resolve();
    };
    ch.onmessage = (event: MessageEvent<Message>) => {
      if (event.data.type === "closed" && event.data.senderId !== SELF_ID) {
        acks++;
        // Reset the settle window: another tab is mid-handshake, give its
        // siblings the same room to answer.
        clearTimeout(settleTimer);
        settleTimer = setTimeout(finish, ACK_SETTLE_MS);
      }
    };
    ch.postMessage({ type: "prepare", senderId: SELF_ID } satisfies Message);
    // No ack within ACK_SETTLE_MS of the last message -> we're alone (or
    // everyone else is dead); proceed either way. The hard timer bounds the
    // pathological case of acks trickling in forever.
    settleTimer = setTimeout(finish, ACK_SETTLE_MS);
    hardTimer = setTimeout(finish, ACK_SETTLE_MS * 4);
  });
}

/**
 * Phase 2 (signing-out tab): announce that the delete has (or definitively
 * has not) completed, releasing every waiting tab to reload. Fire-and-forget
 * on a fresh channel -- the sign-out flow's own channel may not exist yet
 * when only one tab is open, and this tab reloads immediately after anyway.
 */
export function announceSignOutComplete(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const ch = new BroadcastChannel(CHANNEL_NAME);
  ch.postMessage({ type: "done", senderId: SELF_ID } satisfies Message);
  ch.close();
}

/**
 * Follower side: start listening for another tab signing out. On "prepare",
 * runs `closeLocalDatabase()` (close + terminate this tab's worker so it can
 * neither hold the IndexedDB open nor win the election and re-open it),
 * acks, and reloads once "done" arrives (or DONE_TIMEOUT_MS elapses --
 * whichever comes first). Called once per page load from AppShell, the same
 * spot the old multi-tab guard used to start.
 */
export function startSignOutCoordination(closeLocalDatabase: () => Promise<void>): void {
  if (channel) return;
  if (typeof BroadcastChannel === "undefined") return;

  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<Message>) => {
    // Ignore our own broadcasts: this tab is also the one signing out, and
    // BroadcastChannel delivers to every other channel *object* of this
    // name in the page, including this follower's own `channel` (see
    // SELF_ID's comment above).
    if (event.data.senderId === SELF_ID) return;
    if (event.data.type === "prepare") {
      // Ack first, from a fresh channel: the signing-out tab's request
      // channel closes when its settle window ends, and our own `channel`
      // must stay open to hear "done".
      const ack = new BroadcastChannel(CHANNEL_NAME);
      ack.postMessage({ type: "closed", senderId: SELF_ID } satisfies Message);
      ack.close();
      void closeLocalDatabase().finally(() => {
        // Wait for the signing-out tab's "done" (delete finished) before
        // reloading -- reloading early would boot a fresh PGliteWorker that
        // re-opens the database mid-delete. The safety timeout bounds the
        // wait in case that tab died between "prepare" and the delete.
        const done = new BroadcastChannel(CHANNEL_NAME);
        pendingDoneChannel = done;
        pendingSafetyTimer = setTimeout(() => location.reload(), DONE_TIMEOUT_MS);
        done.onmessage = (e: MessageEvent<Message>) => {
          if (e.data.type === "done") {
            clearTimeout(pendingSafetyTimer);
            location.reload();
          }
        };
      });
    }
  };
}

// For tests only -- closes the channel and resets state so each test starts
// from a clean slate regardless of what a previous test did.
export function __resetSignOutCoordinationForTests(): void {
  channel?.close();
  channel = undefined;
  pendingDoneChannel?.close();
  pendingDoneChannel = undefined;
  clearTimeout(pendingSafetyTimer);
  pendingSafetyTimer = undefined;
}
