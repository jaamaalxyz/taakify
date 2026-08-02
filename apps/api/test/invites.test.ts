import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(async () => await admin.end());

async function createHousehold(cookie: string, name = "Invite Test House") {
  const res = await app.request("/api/households", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).household as { id: string; name: string };
}

describe("invites", () => {
  it("owner invites, invitee inspects and accepts", async () => {
    const owner = await signUp(app);
    const house = await createHousehold(owner.cookie);

    const inviteRes = await app.request(`/api/households/${house.id}/invites`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "spouse@test.local", role: "admin" }),
    });
    expect(inviteRes.status).toBe(201);
    const { token } = await inviteRes.json();
    expect(token).toBeTruthy();

    // Anyone with the link can inspect it (pre-signup screen).
    const info = await (await app.request(`/api/invites/${token}`)).json();
    expect(info.householdName).toBe("Invite Test House");
    expect(info.role).toBe("admin");

    const invitee = await signUp(app);
    const accept = await app.request(`/api/invites/${token}/accept`, {
      method: "POST",
      headers: { cookie: invitee.cookie },
    });
    expect(accept.status).toBe(200);

    const me = await (await app.request("/api/me", { headers: { cookie: invitee.cookie } })).json();
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0].role).toBe("admin");
    expect(me.memberships[0].household_id).toBe(house.id);
  });

  it("a non-admin member cannot create invites", async () => {
    const owner = await signUp(app);
    const house = await createHousehold(owner.cookie);
    const outsider = await signUp(app);
    const res = await app.request(`/api/households/${house.id}/invites`, {
      method: "POST",
      headers: { cookie: outsider.cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "x@test.local", role: "member" }),
    });
    expect(res.status).toBe(403);
  });

  it("an invite cannot be accepted twice", async () => {
    const owner = await signUp(app);
    const house = await createHousehold(owner.cookie);
    const { token } = await (
      await app.request(`/api/households/${house.id}/invites`, {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "y@test.local", role: "member" }),
      })
    ).json();

    const first = await signUp(app);
    expect(
      (await app.request(`/api/invites/${token}/accept`, { method: "POST", headers: { cookie: first.cookie } })).status
    ).toBe(200);
    const second = await signUp(app);
    expect(
      (await app.request(`/api/invites/${token}/accept`, { method: "POST", headers: { cookie: second.cookie } })).status
    ).toBe(410);
  });

  it("an expired invite is rejected on inspect and accept", async () => {
    const owner = await signUp(app);
    const house = await createHousehold(owner.cookie);
    const token = "expired-test-token-abc123";
    await admin.query(
      `INSERT INTO invite (household_id, email, role, token, expires_at, created_by)
       SELECT $1, 'late@test.local', 'member', $2, now() - interval '1 day', m.user_id
       FROM membership m WHERE m.household_id = $1 LIMIT 1`,
      [house.id, token]
    );
    expect((await app.request(`/api/invites/${token}`)).status).toBe(410);
    const late = await signUp(app);
    expect(
      (await app.request(`/api/invites/${token}/accept`, { method: "POST", headers: { cookie: late.cookie } })).status
    ).toBe(410);
  });

  it("accepting while already a member is idempotent", async () => {
    const owner = await signUp(app);
    const house = await createHousehold(owner.cookie);
    const invitee = await signUp(app);
    for (const _ of [1, 2]) {
      const { token } = await (
        await app.request(`/api/households/${house.id}/invites`, {
          method: "POST",
          headers: { cookie: owner.cookie, "content-type": "application/json" },
          body: JSON.stringify({ email: "again@test.local", role: "member" }),
        })
      ).json();
      const res = await app.request(`/api/invites/${token}/accept`, {
        method: "POST",
        headers: { cookie: invitee.cookie },
      });
      expect(res.status).toBe(200);
    }
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM membership WHERE household_id = $1 AND deleted_at IS NULL",
      [house.id]
    );
    expect(rows[0].n).toBe(2); // owner + invitee, exactly once each
  });
});
