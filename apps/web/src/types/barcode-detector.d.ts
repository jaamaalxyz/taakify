// Minimal ambient declaration for the Shape Detection API's BarcodeDetector,
// which TypeScript's DOM lib doesn't ship yet. BarcodeScanner.tsx uses it as
// the preferred native scanning path; this covers only the surface we call.
interface BarcodeDetectorOptions {
  formats?: string[];
}

interface DetectedBarcode {
  rawValue: string;
  format: string;
}

declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface Window {
  BarcodeDetector?: typeof BarcodeDetector;
}
