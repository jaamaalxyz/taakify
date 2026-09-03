import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SyncBadge } from "./SyncBadge.js";

// outbox.js is imported "actual" below (for describeOperation/parseBody's
// real implementations), which transitively imports the real db/pglite.js
// singleton -- since issue #17, that singleton eagerly constructs a real
// `new Worker(...)` at module load, which jsdom doesn't provide. Stub it
// out the same way shape.test.ts does; nothing this file exercises through
// the "actual" outbox import touches `db` itself.
vi.mock("../lib/db/pglite.js", () => ({ db: undefined, ready: Promise.resolve() }));

// use-sync-status.js is mocked so each rendering test can drive an exact
// { online, pending, dead } combination without a real outbox/PGlite
// round-trip -- that combination is exactly what SyncBadge's variant logic
// switches on.
const status = vi.hoisted(() => ({ online: true, pending: 0, dead: 0, stalled: false, stale: false }));

vi.mock("../lib/sync/use-sync-status.js", () => ({
  useSyncStatus: () => ({ ...status }),
}));

const outbox = vi.hoisted(() => ({
  listDeadLettered: vi.fn(),
  retry: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("../lib/sync/outbox.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sync/outbox.js")>("../lib/sync/outbox.js");
  return {
    ...actual,
    listDeadLettered: outbox.listDeadLettered,
    retry: outbox.retry,
    dismiss: outbox.dismiss,
  };
});

beforeEach(() => {
  status.online = true;
  status.pending = 0;
  status.dead = 0;
  status.stalled = false;
  status.stale = false;
  outbox.listDeadLettered.mockReset().mockResolvedValue([]);
  outbox.retry.mockReset().mockResolvedValue(undefined);
  outbox.dismiss.mockReset().mockResolvedValue(undefined);
});

describe("SyncBadge states", () => {
  it("renders nothing when fully synced (no pending, no dead)", () => {
    const { container } = render(<SyncBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a destructive 'Offline' badge when offline", () => {
    status.online = false;
    render(<SyncBadge />);
    const badge = screen.getByText("Offline");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("data-variant", "destructive");
  });

  it("renders a secondary 'Saving…' badge when pending > 0 and online", () => {
    status.pending = 2;
    render(<SyncBadge />);
    const badge = screen.getByText("Saving…");
    expect(badge).toHaveAttribute("data-variant", "secondary");
  });

  it("renders a destructive 'Sync unavailable' badge when stalled and online (Critical 2 fix)", () => {
    status.stalled = true;
    render(<SyncBadge />);
    const badge = screen.getByText("Sync unavailable");
    expect(badge).toHaveAttribute("data-variant", "destructive");
  });

  it("prefers 'Offline' over 'Sync unavailable' when both are true", () => {
    status.stalled = true;
    status.online = false;
    render(<SyncBadge />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.queryByText("Sync unavailable")).not.toBeInTheDocument();
  });

  it("renders a destructive 'Not syncing' badge when stale and online (issue #18)", () => {
    status.stale = true;
    render(<SyncBadge />);
    const badge = screen.getByText("Not syncing");
    expect(badge).toHaveAttribute("data-variant", "destructive");
  });

  it("prefers 'Offline' over 'Not syncing' when both are true", () => {
    status.stale = true;
    status.online = false;
    render(<SyncBadge />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.queryByText("Not syncing")).not.toBeInTheDocument();
  });

  it("prefers 'Not syncing' over 'Saving…' when both are true", () => {
    status.stale = true;
    status.pending = 3;
    render(<SyncBadge />);
    expect(screen.getByText("Not syncing")).toBeInTheDocument();
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
  });

  it("renders a destructive 'Sync issue' badge when dead > 0, taking precedence over offline/saving", () => {
    status.dead = 1;
    status.online = false;
    status.pending = 4;
    render(<SyncBadge />);
    const badge = screen.getByText("Sync issue");
    expect(badge).toHaveAttribute("data-variant", "destructive");
    expect(screen.queryByText("Offline")).not.toBeInTheDocument();
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
  });
});

describe("SyncBadge 'Sync issue' dialog", () => {
  it("lists dead-lettered operations via describeOperation, with Retry and Dismiss actions", async () => {
    status.dead = 2;
    outbox.listDeadLettered.mockResolvedValue([
      { id: "row-1", endpoint: "/api/loans/loan-1", method: "PATCH", body: { returned_date: "2026-01-01" } },
      { id: "row-2", endpoint: "/api/contacts", method: "POST", body: { name: "Alex" } },
    ]);

    render(<SyncBadge />);
    screen.getByText("Sync issue").click();

    expect(await screen.findByText("mark loan returned")).toBeInTheDocument();
    expect(screen.getByText("add contact Alex")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Dismiss" })).toHaveLength(2);
  });

  it("Retry calls outbox.retry with the row's id and removes it from the list", async () => {
    status.dead = 1;
    outbox.listDeadLettered.mockResolvedValue([
      { id: "row-1", endpoint: "/api/contacts", method: "POST", body: { name: "Alex" } },
    ]);

    render(<SyncBadge />);
    screen.getByText("Sync issue").click();
    await screen.findByText("add contact Alex");

    screen.getByRole("button", { name: "Retry" }).click();

    await waitFor(() => expect(outbox.retry).toHaveBeenCalledWith("row-1"));
    await waitFor(() => expect(screen.queryByText("add contact Alex")).not.toBeInTheDocument());
  });

  it("Dismiss calls outbox.dismiss with the row's id and removes it from the list", async () => {
    status.dead = 1;
    outbox.listDeadLettered.mockResolvedValue([
      { id: "row-1", endpoint: "/api/contacts", method: "POST", body: { name: "Alex" } },
    ]);

    render(<SyncBadge />);
    screen.getByText("Sync issue").click();
    await screen.findByText("add contact Alex");

    screen.getByRole("button", { name: "Dismiss" }).click();

    await waitFor(() => expect(outbox.dismiss).toHaveBeenCalledWith("row-1"));
    await waitFor(() => expect(screen.queryByText("add contact Alex")).not.toBeInTheDocument());
  });

  it("permanent (server-rejected) rows show why and offer no Retry, only Dismiss", async () => {
    status.dead = 1;
    outbox.listDeadLettered.mockResolvedValue([
      {
        id: "row-1",
        endpoint: "/api/contacts",
        method: "POST",
        body: { name: "Alex" },
        permanent: true,
      },
    ]);

    render(<SyncBadge />);
    screen.getByText("Sync issue").click();

    expect(await screen.findByText("add contact Alex — the server rejected this change")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});
