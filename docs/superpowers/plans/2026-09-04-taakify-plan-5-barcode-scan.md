# Taakify Plan 5: Barcode Scanning on Add (ISBN tab)

**Date:** 2026-09-04
**Status:** Implemented
**Spec refs:** Goal #5, Journey 2 (gap-filling during bulk cataloging), Journey 3
("at the bookstore (offline) — scan-to-wishlist"), Screen #3 (Add).
**Gap analysis:** `2026-09-03-taakify-design-spec-gaps.md` gap #2 (P1).

## Goal

Make the Add screen's ISBN tab camera-first: a "Scan barcode" button opens
the rear camera, decodes the book's EAN-13/UPC barcode, and feeds the
decoded ISBN through the **existing** lookup flow unchanged. No new API
route, no data-model change — this is a faster input path for the flow that
already exists, enabling the mobile journeys the spec frames the app around.

## Design

- New component `apps/web/src/components/BarcodeScanner.tsx`:
  - Prefers the native `BarcodeDetector` (all modern mobile browsers; no
    dependency, no wasm download) with a rear-camera (`facingMode:
    "environment"`) stream; falls back to ZXing
    (`@zxing/browser` `BrowserMultiFormatReader`, hinted to EAN-13/EAN-8/
    UPC-A) where the API is missing.
  - Only codes matching 8–14 digits are surfaced (QR URLs etc. are ignored,
    scanning continues), and a code is surfaced exactly once — the camera is
    stopped before the parent callback so a live preview can't double-fire
    while the lookup runs.
  - Camera failures degrade to clear copy, never a dead end: permission
    blocked → "allow the camera or type the ISBN instead"; no camera found;
    generic start failure. The typed-ISBN input is always present next to it.
- `Add.tsx` ISBN tab gains a "Scan barcode" toggle; a detection sets the
  ISBN field, closes the scanner, and fires `handleLookup(code)` — the same
  function the "Look up" button uses (now parameterized, since the state
  update isn't visible yet at call time).
- Offline behavior: scanning works offline (camera + decode are local);
  the lookup misses offline and falls through to the existing
  "No match found — enter the details manually" path, which is exactly the
  spec's Journey 3 bookstore shape (scan now, fill details by hand).
- New deps: `@zxing/browser` + `@zxing/library` (web only).

## Testing

- `BarcodeScanner.test.tsx` (jsdom has no `BarcodeDetector`, so tests
  exercise the ZXing fallback path with the reader mocked): decode surfaced
  once + camera stopped; non-ISBN codes ignored; permission/no-camera
  error copy; stop button.
- `Add.test.tsx`: scanning fills the ISBN, fires
  `/api/editions/lookup?isbn=…`, prefills the title, and closes the
  scanner.
