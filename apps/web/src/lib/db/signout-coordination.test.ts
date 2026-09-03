import { describe, it, expect, afterEach, vi } from "vitest";
import {
  requestOtherTabsToClose,
  announceSignOutComplete,
  startSignOutCoordination,
  ACK_SETTLE_MS,
  __resetSignOutCoordinationForTests,
} from "./signout-coordination.js";

const CHANNEL_NAME = "taakify-signout";

// Real timers throughout: the whole protocol is built on BroadcastChannel
// delivery plus wall-clock settle windows, and mixing fake timers with
// jsdom's async message dispatch is flakier than just waiting the ~1s the
// windows actually take.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flushMessages = () => sleep(20);

afterEach(() => {
  __resetSignOutCoordinationForTests();
  vi.useRealTimers();
});

describe("signout-coordination (issue #17)", () => {
  it(`phase 1 resolves on its own after the ${ACK_SETTLE_MS}ms settle window when no other tab is listening`, async () => {
    let resolved = false;
    const promise = requestOtherTabsToClose().then(() => {
      resolved = true;
    });
    await sleep(ACK_SETTLE_MS - 200);
    expect(resolved).toBe(false);
    await sleep(400);
    expect(resolved).toBe(true);
    await promise;
  });

  it("phase 1 is a no-op resolve in environments without BroadcastChannel", async () => {
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error deliberately absent for this test
    delete globalThis.BroadcastChannel;
    try {
      await expect(requestOtherTabsToClose()).resolves.toBeUndefined();
    } finally {
      globalThis.BroadcastChannel = original;
    }
  });

  it("a listening follower closes its local database and acks when a prepare arrives", async () => {
    const closeLocalDatabase = vi.fn().mockResolvedValue(undefined);
    startSignOutCoordination(closeLocalDatabase);

    // Watch for the follower's ack on a raw channel, and play the role of
    // the signing-out tab by posting "prepare" directly.
    let sawAck = false;
    const watcher = new BroadcastChannel(CHANNEL_NAME);
    watcher.onmessage = (e: MessageEvent<{ type: string }>) => {
      if (e.data.type === "closed") sawAck = true;
    };

    const signer = new BroadcastChannel(CHANNEL_NAME);
    signer.postMessage({ type: "prepare" });
    await flushMessages();

    expect(sawAck).toBe(true);
    expect(closeLocalDatabase).toHaveBeenCalledTimes(1);
    watcher.close();
    signer.close();
  });

  it("startSignOutCoordination is idempotent: a second call doesn't double-register", async () => {
    const closeLocalDatabase = vi.fn().mockResolvedValue(undefined);
    startSignOutCoordination(closeLocalDatabase);
    startSignOutCoordination(closeLocalDatabase);

    const signer = new BroadcastChannel(CHANNEL_NAME);
    signer.postMessage({ type: "prepare" });
    await flushMessages();

    expect(closeLocalDatabase).toHaveBeenCalledTimes(1);
    signer.close();
  });

  it("phase 1 waits for a foreign tab's ack before resolving (ack extends the settle window)", async () => {
    // requestOtherTabsToClose() and startSignOutCoordination() both run in
    // THIS module instance, tagged with the same SELF_ID -- using
    // startSignOutCoordination here would just test the self-filtering fix
    // above, not phase 1's ack-waiting logic. Simulate a genuinely foreign
    // tab's follower by hand instead: ack immediately on "prepare", using a
    // senderId this module's SELF_ID can't match.
    const foreignTab = new BroadcastChannel(CHANNEL_NAME);
    foreignTab.onmessage = (e: MessageEvent<{ type: string }>) => {
      if (e.data.type === "prepare") {
        foreignTab.postMessage({ type: "closed", senderId: "foreign-tab" });
      }
    };

    let resolved = false;
    const promise = requestOtherTabsToClose().then(() => {
      resolved = true;
    });

    // The foreign ack lands quickly (jsdom BroadcastChannel dispatch is
    // near-immediate) and resets the settle window: shortly after the ack
    // we're still waiting...
    await sleep(200);
    expect(resolved).toBe(false);
    // ...and once the full post-ack window elapses, phase 1 resolves.
    await sleep(ACK_SETTLE_MS + 200);
    expect(resolved).toBe(true);
    await promise;
    foreignTab.close();
  });

  it("code review finding: a tab's own startSignOutCoordination follower does not react to that same tab's own requestOtherTabsToClose/announceSignOutComplete calls", async () => {
    // BroadcastChannel delivers to every OTHER channel *object* of the same
    // name in the same page -- not just objects in other tabs -- so a
    // signing-out tab that also runs startSignOutCoordination (every tab
    // does, via AppShell's useSignOutCoordination) receives its own
    // "prepare"/"done" messages unless the protocol explicitly filters them
    // out. Unfiltered, this closes the local database a second time
    // (harmless) but also reloads the page the instant announceSignOutComplete
    // fires, racing performSignOut's own authClient.signOut().finally(reload)
    // and potentially aborting the sign-out request before the server-side
    // session is invalidated.
    const closeLocalDatabase = vi.fn().mockResolvedValue(undefined);
    startSignOutCoordination(closeLocalDatabase);

    await requestOtherTabsToClose();
    expect(closeLocalDatabase).not.toHaveBeenCalled();

    const reloadSpy = vi.fn();
    const originalReload = location.reload;
    location.reload = reloadSpy;
    try {
      announceSignOutComplete();
      await flushMessages();
      expect(reloadSpy).not.toHaveBeenCalled();
    } finally {
      location.reload = originalReload;
    }
  });

  it("announceSignOutComplete delivers a done message other tabs can hear", async () => {
    let sawDone = false;
    const watcher = new BroadcastChannel(CHANNEL_NAME);
    watcher.onmessage = (e: MessageEvent<{ type: string }>) => {
      if (e.data.type === "done") sawDone = true;
    };

    announceSignOutComplete();
    await flushMessages();

    expect(sawDone).toBe(true);
    watcher.close();
  });
});
