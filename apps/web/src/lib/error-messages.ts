// Shared friendly-copy layer for every screen's error state.
//
// Every screen used to do `catch (err) { setXError((err as Error).message) }`
// and render the raw server string straight into an Alert. That leaked
// backend language ("forbidden", "nothing to update") to non-technical
// users, and worse, some strings ("forbidden", "not found") are reused
// across unrelated routes for different underlying situations — so the text
// can't reliably be mapped 1:1 to a cause. `ApiError.status` (see `api.ts`)
// is the stable signal; branch on that first, and only fall back to a small
// allowlist of server messages that are already clear enough to show as-is.
//
// This module is the same pattern as `lib/labels.ts`: one shared source of
// truth instead of one ad hoc mapping per screen.

import { ApiError } from "./api.js";

const DEFAULT_MESSAGE = "Something went wrong. Please try again.";
const NETWORK_MESSAGE = "Couldn't connect. Check your connection and try again.";

// Server messages that are already clear, non-technical, and actionable —
// safe to pass straight through instead of collapsing to the generic
// fallback. Covers "nothing to update" and the validation messages named in
// the issue (direction / rating / reading-status enum).
const MESSAGE_ALLOWLIST = new Set<string>([
  "nothing to update",
  "direction must be 'lent_out' or 'borrowed_in'",
  "rating must be between 1 and 5",
]);

// "status must be one of ..." has the valid values interpolated onto the
// end server-side (see reading-status.ts), so it can't be an exact-string
// allowlist entry — match the stable prefix instead.
const STATUS_ENUM_PREFIX = "status must be one of ";

export function friendlyError(err: unknown): string {
  // Every real response from `api()` throws `ApiError` (see api.ts) — the
  // status code is the one signal stable enough to branch on. Anything else
  // reaching a catch block (a raw `TypeError` from `fetch` itself failing
  // before a response, or any other non-`ApiError` throw) means the request
  // never got a response at all, so it gets the same "couldn't connect"
  // copy regardless of whether it's an `Error` instance or not.
  if (!(err instanceof ApiError)) {
    return NETWORK_MESSAGE;
  }

  switch (err.status) {
    case 401:
      return "Please sign in again.";
    case 403:
      return "You don't have permission to do that.";
    case 404:
      return "That doesn't exist anymore — try refreshing.";
    default:
      if (MESSAGE_ALLOWLIST.has(err.message) || err.message.startsWith(STATUS_ENUM_PREFIX)) {
        return err.message;
      }
      return DEFAULT_MESSAGE;
  }
}
