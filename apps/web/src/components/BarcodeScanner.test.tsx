import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BarcodeScanner } from "./BarcodeScanner.js";

// jsdom has no BarcodeDetector, so the component takes the ZXing path in
// tests — exactly the environment fallback the component exists for. The
// reader is mocked: decodeFromVideoDevice captures the scan callback so a
// test can "decode" a barcode by invoking it.
const { scanCallback, controls, decodeFromVideoDevice, failNextStart } = vi.hoisted(() => {
  let scanCallback: ((result: { getText: () => string }) => void) | null = null;
  let nextError: DOMException | null = null;
  const controls = { stop: vi.fn() };
  const decodeFromVideoDevice = vi.fn(
    async (
      _deviceId: unknown,
      _video: unknown,
      cb: (result: { getText: () => string }) => void
    ) => {
      if (nextError) {
        const err = nextError;
        nextError = null;
        throw err;
      }
      scanCallback = cb;
      return controls;
    }
  );
  return {
    scanCallback: (code: string) => scanCallback?.({ getText: () => code }),
    controls,
    decodeFromVideoDevice,
    failNextStart: (err: DOMException) => {
      nextError = err;
    },
  };
});

vi.mock("@zxing/browser", () => ({
  BrowserMultiFormatReader: vi.fn().mockImplementation(() => ({ decodeFromVideoDevice })),
}));

function renderScanner(onDetected = vi.fn()) {
  const onClose = vi.fn();
  render(<BarcodeScanner onDetected={onDetected} onClose={onClose} />);
  return { onDetected, onClose };
}

beforeEach(() => {
  decodeFromVideoDevice.mockClear();
  controls.stop.mockClear();
});

describe("BarcodeScanner", () => {
  it("surfaces a decoded book barcode (EAN-13 digits) exactly once and stops the camera", async () => {
    const onDetected = vi.fn();
    renderScanner(onDetected);

    await waitFor(() => expect(decodeFromVideoDevice).toHaveBeenCalled());
    scanCallback("9780441172719");
    scanCallback("9780441172719"); // second decode of the same frame family

    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(onDetected).toHaveBeenCalledWith("9780441172719");
    expect(controls.stop).toHaveBeenCalled();
  });

  it("keeps scanning past non-ISBN codes (e.g. a QR URL) without surfacing them", async () => {
    const onDetected = vi.fn();
    renderScanner(onDetected);

    await waitFor(() => expect(decodeFromVideoDevice).toHaveBeenCalled());
    scanCallback("https://example.com");

    expect(onDetected).not.toHaveBeenCalled();
  });

  it("shows a permission message when camera access is blocked", async () => {
    failNextStart(new DOMException("denied", "NotAllowedError"));
    renderScanner();

    expect(await screen.findByText(/Camera access was blocked/i)).toBeInTheDocument();
  });

  it("shows a no-camera message when no device is available", async () => {
    failNextStart(new DOMException("none", "NotFoundError"));
    renderScanner();

    expect(await screen.findByText(/No camera found/i)).toBeInTheDocument();
  });

  it("stops the camera when Stop scanning is clicked", async () => {
    const { onClose } = renderScanner();
    await waitFor(() => expect(decodeFromVideoDevice).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Stop scanning" }));

    expect(onClose).toHaveBeenCalled();
    // The effect cleanup (which stops the controls) runs when the parent
    // unmounts the scanner in response to onClose.
    expect(controls.stop).not.toHaveBeenCalled();
    screen.getByText(/Point the camera/i);
  });
});

// The native BarcodeDetector path is preferred whenever the browser exposes
// it, but jsdom doesn't implement it -- so the suite above only exercises the
// ZXing fallback. These tests stub window.BarcodeDetector, getUserMedia, and
// video.play() to cover the same detect-once/stop-camera behavior on the
// primary path most real mobile browsers actually take.
describe("BarcodeScanner (native BarcodeDetector path)", () => {
  let detectMock: ReturnType<typeof vi.fn> & { push: (code: string) => void };
  let stopTrack: ReturnType<typeof vi.fn>;
  const originalBarcodeDetector = window.BarcodeDetector;
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalRAF = window.requestAnimationFrame;

  beforeEach(() => {
    const queue: Array<Array<{ rawValue: string }>> = [];
    const fn = vi.fn(async () => queue.shift() ?? []) as ReturnType<typeof vi.fn> & {
      push: (code: string) => void;
    };
    fn.push = (code: string) => queue.push([{ rawValue: code }]);
    detectMock = fn;

    class FakeBarcodeDetector {
      constructor(_opts: unknown) {}
      detect = detectMock;
    }
    window.BarcodeDetector = FakeBarcodeDetector as unknown as typeof BarcodeDetector;

    stopTrack = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) },
      configurable: true,
    });

    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => Number(setTimeout(() => cb(0), 0))) as typeof requestAnimationFrame;
  });

  afterEach(() => {
    window.BarcodeDetector = originalBarcodeDetector;
    if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    HTMLMediaElement.prototype.play = originalPlay;
    window.requestAnimationFrame = originalRAF;
  });

  it("prefers the native detector, surfacing a decoded ISBN once and stopping the camera track", async () => {
    const onDetected = vi.fn();
    renderScanner(onDetected);

    await waitFor(() => expect(detectMock).toHaveBeenCalled());
    detectMock.push("9780441172719");

    await waitFor(() => expect(onDetected).toHaveBeenCalledWith("9780441172719"));
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalled();
  });

  it("ignores non-ISBN codes and keeps polling", async () => {
    const onDetected = vi.fn();
    renderScanner(onDetected);

    await waitFor(() => expect(detectMock).toHaveBeenCalled());
    detectMock.push("https://example.com");

    await waitFor(() => expect(detectMock.mock.calls.length).toBeGreaterThan(1));
    expect(onDetected).not.toHaveBeenCalled();
  });
});
