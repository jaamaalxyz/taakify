import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name = "Test Family Library") {
  const res = await app.request("/api/households", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).household as { id: string; name: string };
}

// Owner invites `email`; a freshly-signed-up user accepts and returns their cookie.
async function acceptInvite(ownerCookie: string, householdId: string, role: "admin" | "member", name: string) {
  const inviteRes = await app.request(`/api/households/${householdId}/invites`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ email: `${name}@test.local`, role }),
  });
  const { token } = await inviteRes.json();
  const invitee = await signUp(app, `${name}@test.local`);
  const accept = await app.request(`/api/invites/${token}/accept`, {
    method: "POST",
    headers: { cookie: invitee.cookie },
  });
  expect(accept.status).toBe(200);
  return invitee;
}

describe("households", () => {
  it("creates a household with the creator as owner", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/households", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Test Family Library" }),
    });
    expect(res.status).toBe(201);
    const { household } = await res.json();
    expect(household.name).toBe("Test Family Library");

    const me = await (await app.request("/api/me", { headers: { cookie } })).json();
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0].role).toBe("owner");
    expect(me.memberships[0].household_id).toBe(household.id);
  });

  it("rejects empty names", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/households", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("requires auth", async () => {
    const res = await app.request("/api/households", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("household members", () => {
  it("lists members with id/name/email/role — owner + an accepted invitee", async () => {
    const owner = await signUp(app, "owner@members.test");
    const house = await createHousehold(owner.cookie, "Members House");
    await acceptInvite(owner.cookie, house.id, "member", "spouse");

    const res = await app.request(`/api/households/${house.id}/members`, {
      headers: { cookie: owner.cookie },
    });
    expect(res.status).toBe(200);
    const { members } = await res.json();
    expect(members).toHaveLength(2);

    const byEmail = Object.fromEntries(members.map((m: { email: string }) => [m.email, m]));
    expect(byEmail["owner@members.test"]).toMatchObject({ name: "Test User", role: "owner" });
    expect(byEmail["spouse@test.local"]).toMatchObject({ name: "Test User", role: "member" });
    // Every row carries the four documented fields, nothing sensitive leaks
    // (no password / account tokens — the user table holds those elsewhere).
    for (const m of members) {
      expect(Object.keys(m).sort()).toEqual(["email", "id", "name", "role"]);
    }
  });

  it("RLS: a non-member gets 403 and never sees the roster", async () => {
    const owner = await signUp(app, "owner2@members.test");
    const house = await createHousehold(owner.cookie, "Private House");
    await acceptInvite(owner.cookie, house.id, "member", "insider");

    const outsider = await signUp(app, "outsider@members.test");
    const res = await app.request(`/api/households/${house.id}/members`, {
      headers: { cookie: outsider.cookie },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("members");
  });

  it("requires auth", async () => {
    const res = await app.request("/api/households/anything/members");
    expect(res.status).toBe(401);
  });
});
