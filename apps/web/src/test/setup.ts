import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

Object.defineProperty(window, "location", {
  configurable: true,
  value: { ...window.location, reload: vi.fn() },
});
