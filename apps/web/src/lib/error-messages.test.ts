import { describe, it, expect } from "vitest";
import { friendlyError } from "./error-messages.js";
import { ApiError } from "./api.js";

// Same rigor as labels.test.ts: pin exact copy for every branch rather than
// just asserting "a string comes back", since the whole point of this
// module is that every screen shows the same, deliberately-worded string
// for a given failure.

describe("friendlyError", () => {
  it("maps 401 to a sign-in-again message", () => {
    expect(friendlyError(new ApiError("forbidden", 401))).toBe("Please sign in again.");
  });

  it("maps 403 to a permission message, regardless of the server's wording", () => {
    expect(friendlyError(new ApiError("forbidden", 403))).toBe(
      "You don't have permission to do that."
    );
  });

  it("maps 404 to a refresh message, regardless of the server's wording", () => {
    expect(friendlyError(new ApiError("not found", 404))).toBe(
      "That doesn't exist anymore — try refreshing."
    );
  });

  it("passes through the allowlisted 'nothing to update' message", () => {
    expect(friendlyError(new ApiError("nothing to update", 400))).toBe("nothing to update");
  });

  it("passes through the allowlisted direction validation message", () => {
    expect(
      friendlyError(new ApiError("direction must be 'lent_out' or 'borrowed_in'", 400))
    ).toBe("direction must be 'lent_out' or 'borrowed_in'");
  });

  it("passes through the allowlisted rating validation message", () => {
    expect(friendlyError(new ApiError("rating must be between 1 and 5", 400))).toBe(
      "rating must be between 1 and 5"
    );
  });

  it("passes through the reading-status enum message by stable prefix, whatever the enum list is", () => {
    expect(
      friendlyError(
        new ApiError("status must be one of unread, want_to_read, reading, finished", 400)
      )
    ).toBe("status must be one of unread, want_to_read, reading, finished");
  });

  it("falls back to a generic message for a 400 that isn't allowlisted", () => {
    expect(friendlyError(new ApiError("bookId is required", 400))).toBe(
      "Something went wrong. Please try again."
    );
  });

  it("falls back to a generic message for an unrecognized status code", () => {
    expect(friendlyError(new ApiError("internal error", 500))).toBe(
      "Something went wrong. Please try again."
    );
  });

  it("falls back to a 'couldn't connect' message for a plain Error (e.g. a network TypeError)", () => {
    expect(friendlyError(new TypeError("Failed to fetch"))).toBe(
      "Couldn't connect. Check your connection and try again."
    );
    expect(friendlyError(new Error("some other failure"))).toBe(
      "Couldn't connect. Check your connection and try again."
    );
  });

  it("falls back to a 'couldn't connect' message for a non-Error throw", () => {
    expect(friendlyError("a raw string throw")).toBe(
      "Couldn't connect. Check your connection and try again."
    );
    expect(friendlyError(undefined)).toBe(
      "Couldn't connect. Check your connection and try again."
    );
  });
});
