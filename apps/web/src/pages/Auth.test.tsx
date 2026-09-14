import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Auth } from "./Auth.js";
import { authClient } from "../lib/auth.js";

vi.mock("../lib/auth.js", () => ({
  authClient: {
    emailOtp: { sendVerificationOtp: vi.fn(), verifyEmail: vi.fn() },
    signIn: { emailOtp: vi.fn(), social: vi.fn() },
    getSession: vi.fn(),
  },
}));

function renderAuth() {
  render(
    <MemoryRouter>
      <Auth />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockReset().mockResolvedValue({ error: null } as never);
  vi.mocked(authClient.signIn.emailOtp).mockReset();
  vi.mocked(authClient.signIn.social).mockReset();
});

describe("Auth", () => {
  it("sends a code, then verifies it and signs in", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.signIn.emailOtp).mockResolvedValue({
      data: { token: "t", user: { id: "u1" } },
      error: null,
    } as never);
    renderAuth();

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Continue with email" }));

    await waitFor(() =>
      expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
        email: "ada@example.com",
        type: "sign-in",
      })
    );
    expect(await screen.findByLabelText(/6-digit code/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/6-digit code/i), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(authClient.signIn.emailOtp).toHaveBeenCalledWith({
        email: "ada@example.com",
        otp: "123456",
        name: "",
      })
    );
  });

  it("shows an error when sending the code fails", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
      error: { message: "Too many requests" },
    } as never);
    renderAuth();

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Continue with email" }));

    expect(await screen.findByText("Too many requests")).toBeInTheDocument();
  });

  it("offers Google sign-in", async () => {
    const user = userEvent.setup();
    renderAuth();
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(authClient.signIn.social).toHaveBeenCalledWith({ provider: "google", callbackURL: "/" });
  });
});
