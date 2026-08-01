import "@testing-library/jest-dom/vitest";
import { vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

Object.defineProperty(window, "location", {
  configurable: true,
  value: { ...window.location, reload: vi.fn() },
});

afterEach(() => {
  cleanup();
});
