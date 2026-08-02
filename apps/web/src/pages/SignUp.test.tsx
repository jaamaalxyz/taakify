import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SignUp } from "./SignUp.js";
import { authClient } from "../lib/auth.js";

vi.mock("../lib/auth.js", () => ({
  authClient: {
    signUp: { email: vi.fn() },
    signIn: { social: vi.fn() },
    getSession: vi.fn(),
  },
}));

function renderSignUp() {
  render(
    <MemoryRouter initialEntries={["/signup"]}>
      <Routes>
        <Route path="/signup" element={<SignUp />} />
        {/* Catch the post-submit navigate("/onboarding") so react-router doesn't warn. */}
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(authClient.signUp.email).mockReset();
  vi.mocked(authClient.signIn.social).mockReset();
  vi.mocked(authClient.getSession).mockReset();
});

describe("SignUp", () => {
  it("submits name, email, and password to authClient.signUp.email", async () => {
    vi.mocked(authClient.signUp.email).mockResolvedValue({ error: null } as never);
    vi.mocked(authClient.getSession).mockResolvedValue({} as never);
    renderSignUp();

    await userEvent.type(screen.getByLabelText("Your name"), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "hunter22");
    await userEvent.click(screen.getByRole("button", { name: "Sign up" }));

    expect(authClient.signUp.email).toHaveBeenCalledWith({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "hunter22",
    });
  });

  it("shows an alert when sign-up fails", async () => {
    vi.mocked(authClient.signUp.email).mockResolvedValue({
      error: { message: "Email already in use" },
    } as never);
    renderSignUp();

    await userEvent.type(screen.getByLabelText("Your name"), "Ada");
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "hunter22");
    await userEvent.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByText("Email already in use")).toBeInTheDocument();
  });

  it("triggers Google sign-in on button click", async () => {
    renderSignUp();
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(authClient.signIn.social).toHaveBeenCalledWith({ provider: "google", callbackURL: "/" });
  });
});
