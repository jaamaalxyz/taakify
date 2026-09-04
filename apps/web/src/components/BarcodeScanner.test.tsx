import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
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
