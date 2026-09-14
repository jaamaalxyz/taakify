import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Logo } from "./Logo.js";

describe("Logo", () => {
  it("renders an svg mark, hidden from assistive tech by default", () => {
    const { container } = render(<Logo className="h-5 w-5" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("h-5", "w-5");
  });
});
