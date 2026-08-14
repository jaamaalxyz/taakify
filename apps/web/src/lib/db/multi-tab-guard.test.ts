import { describe, it, expect, afterEach } from "vitest";
import {
  startMultiTabGuard,
  getMultiTabDetected,
  onMultiTabChange,
  __resetMultiTabGuardForTests,
} from "./multi-tab-guard.js";

const CHANNEL_NAME = "taakify-pglite-tabs";

afterEach(() => {
  __resetMultiTabGuardForTests();
});

describe("multi-tab-guard", () => {
  it("stays false with no other tab present", async () => {
    startMultiTabGuard();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getMultiTabDetected()).toBe(false);
  });

  it("detects a tab that joins after this one has already started (ack path)", async () => {
    startMultiTabGuard();
    let notified = false;
    onMultiTabChange(() => {
      notified = true;
    });

    const other = new BroadcastChannel(CHANNEL_NAME);
    other.postMessage({ type: "hello" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getMultiTabDetected()).toBe(true);
    expect(notified).toBe(true);
    other.close();
  });

  it("announces itself so a tab that was already open sees a 'hello' (hello path)", async () => {
    const other = new BroadcastChannel(CHANNEL_NAME);
    let sawHello = false;
    other.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data.type === "hello") sawHello = true;
    };

    startMultiTabGuard();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sawHello).toBe(true);
    other.close();
  });

  it("is idempotent: calling it twice doesn't reset already-detected state", async () => {
    startMultiTabGuard();
    const other = new BroadcastChannel(CHANNEL_NAME);
    other.postMessage({ type: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getMultiTabDetected()).toBe(true);

    startMultiTabGuard();
    expect(getMultiTabDetected()).toBe(true);
    other.close();
  });

  it("notifies subscribers only once even if multiple messages arrive", async () => {
    startMultiTabGuard();
    let notifications = 0;
    onMultiTabChange(() => {
      notifications++;
    });

    const other = new BroadcastChannel(CHANNEL_NAME);
    other.postMessage({ type: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    other.postMessage({ type: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(notifications).toBe(1);
    other.close();
  });

  it("stops delivering to a listener after unsubscribe", async () => {
    startMultiTabGuard();
    let notified = false;
    const unsubscribe = onMultiTabChange(() => {
      notified = true;
    });
    unsubscribe();

    const other = new BroadcastChannel(CHANNEL_NAME);
    other.postMessage({ type: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notified).toBe(false);
    other.close();
  });
});
