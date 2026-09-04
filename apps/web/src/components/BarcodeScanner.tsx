// Camera barcode scanner for the Add screen's ISBN tab (design spec gap #2,
// Journey 2/3: fast cataloging and scan-to-wishlist at the bookstore).
//
// Uses the native BarcodeDetector when the browser provides one (all modern
// mobile browsers) and falls back to ZXing's BrowserMultiFormatReader
// elsewhere, so the feature works everywhere without making ZXing the only
// path. A decoded code is surfaced through onDetected exactly once; the
// parent decides what to do with it (pre-fill the ISBN and look it up).
import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { Button } from "./ui/button.js";

export interface BarcodeScannerProps {
  onDetected: (code: string) => void;
  onClose: () => void;
}

// Book barcodes are EAN-13 (ISBN-13), with older/rare ones as EAN-8 or
// UPC-A. Anything that isn't 8-14 digits isn't an ISBN-family code — keep
// scanning rather than surfacing a QR URL or similar.
const BOOK_BARCODE_FORMATS = [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A];

function looksLikeIsbn(code: string): boolean {
  return /^\d{8,14}$/.test(code);
}

export function BarcodeScanner({ onDetected, onClose }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const detectedRef = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    detectedRef.current = false;
    const video = videoRef.current;
    if (!video) return;

    let controls: IScannerControls | null = null;
    let cancelled = false;
    let stream: MediaStream | null = null;

    function detect(code: string) {
      if (detectedRef.current || !looksLikeIsbn(code)) return;
      detectedRef.current = true;
      controls?.stop();
      onDetected(code);
    }

    const start = async () => {
      try {
        if (window.BarcodeDetector) {
          // Native path: own the camera here and poll the detector — no
          // ZXing involved on browsers that ship it.
          const detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a"] });
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          video.srcObject = stream;
          await video.play();
          const tick = async () => {
            if (detectedRef.current || cancelled) return;
            try {
              const codes = await detector.detect(video);
              if (codes.length > 0) detect(codes[0].rawValue);
            } catch {
              // A transient per-frame failure (e.g. no frame decoded yet)
              // is normal while scanning — just keep polling.
            }
            if (!detectedRef.current && !cancelled) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        } else {
          const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, BOOK_BARCODE_FORMATS]]);
          const reader = new BrowserMultiFormatReader(hints);
          controls = await reader.decodeFromVideoDevice(undefined, video, (result) => {
            if (result) detect(result.getText());
          });
          if (cancelled) controls.stop();
        }
      } catch (err) {
        if (cancelled) return;
        const name = err instanceof DOMException ? err.name : "";
        if (name === "NotAllowedError") {
          setError("Camera access was blocked. Allow the camera in your browser settings, or type the ISBN instead.");
        } else if (name === "NotFoundError") {
          setError("No camera found on this device. Type the ISBN instead.");
        } else {
          setError("Couldn't start the camera. Type the ISBN instead.");
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      controls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onDetected]);

  return (
    <div className="space-y-2">
      {!error && <video ref={videoRef} className="w-full rounded-md bg-black" muted playsInline />}
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <p className="text-sm text-muted-foreground">Point the camera at the book's barcode…</p>
      )}
      <Button type="button" variant="outline" size="sm" onClick={onClose}>
        Stop scanning
      </Button>
    </div>
  );
}
