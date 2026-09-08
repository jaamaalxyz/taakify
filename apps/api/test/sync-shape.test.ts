import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name = "Shape Proxy Test House") {
  const res = await app.request("/api/households", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).household as { id: string };
}

function mockElectricResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("GET /api/sync/shape", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("requires auth", async () => {
    const res = await app.request("/api/sync/shape?table=book&householdId=x");
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects an unknown table", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/sync/shape?table=user&householdId=x", { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("requires householdId for a tenant table", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/sync/shape?table=book", { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("forbids a household the caller is not a member of", async () => {
    const owner = await signUp(app);
    const house = await createHousehold(owner.cookie);
    const outsider = await signUp(app);

    const res = await app.request(`/api/sync/shape?table=book&householdId=${house.id}`, {
      headers: { cookie: outsider.cookie },
    });
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("forwards a tenant-table request to Electric with a server-derived where clause, ignoring any client-supplied where", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    vi.mocked(global.fetch).mockResolvedValue(mockElectricResponse("[]", { "electric-offset": "0_0" }));

    const res = await app.request(
      `/api/sync/shape?table=book&householdId=${house.id}&offset=-1&live=false&where=1=1`,
      { headers: { cookie } }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("electric-offset")).toBe("0_0");

    const [calledUrl] = vi.mocked(global.fetch).mock.calls[0];
    const upstream = new URL(calledUrl as string);
    expect(upstream.searchParams.get("table")).toBe("book");
    expect(upstream.searchParams.get("replica")).toBe("full");
    expect(upstream.searchParams.get("where")).toBe("household_id = $1");
    expect(upstream.searchParams.get("params[1]")).toBe(house.id);
    // Client-supplied `where` above must never reach Electric verbatim.
    expect(upstream.searchParams.get("where")).not.toBe("1=1");
    // Electric protocol params are forwarded through unchanged.
    expect(upstream.searchParams.get("offset")).toBe("-1");
    expect(upstream.searchParams.get("live")).toBe("false");
  });

  it("forwards the global edition table with no where clause and no householdId required", async () => {
    const { cookie } = await signUp(app);
    vi.mocked(global.fetch).mockResolvedValue(mockElectricResponse("[]"));

    const res = await app.request("/api/sync/shape?table=edition&offset=-1", { headers: { cookie } });

    expect(res.status).toBe(200);
    const [calledUrl] = vi.mocked(global.fetch).mock.calls[0];
    const upstream = new URL(calledUrl as string);
    expect(upstream.searchParams.get("table")).toBe("edition");
    expect(upstream.searchParams.has("where")).toBe(false);
    expect(upstream.searchParams.has("params[1]")).toBe(false);
  });

  it("never forwards a client-supplied where/params override, even if the client is a member of the household it claims", async () => {
    const owner = await signUp(app);
    const house = await createHousehold(owner.cookie);
    const attacker = await signUp(app);
    const attackerHouse = await createHousehold(attacker.cookie);
    vi.mocked(global.fetch).mockResolvedValue(mockElectricResponse("[]"));

    // The attacker is a real member of attackerHouse, and tries to smuggle
    // house's id into a raw `params[1]` override alongside their own
    // (legitimate) householdId query param, hoping the proxy blindly forwards
    // client query params instead of always deriving them server-side.
    const res = await app.request(
      `/api/sync/shape?table=book&householdId=${attackerHouse.id}&params[1]=${house.id}`,
      { headers: { cookie: attacker.cookie } }
    );

    expect(res.status).toBe(200);
    const [calledUrl] = vi.mocked(global.fetch).mock.calls[0];
    const upstream = new URL(calledUrl as string);
    // Must reflect the attacker's OWN verified household, never the smuggled
    // value from the raw query string.
    expect(upstream.searchParams.get("params[1]")).toBe(attackerHouse.id);
    expect(upstream.searchParams.get("params[1]")).not.toBe(house.id);
  });
});
