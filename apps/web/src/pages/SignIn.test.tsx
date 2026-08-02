import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SignIn } from "./SignIn.js";
import { authClient } from "../lib/auth.js";

vi.mock("../lib/auth.js", () => ({
  authClient: {
    signIn: { email: vi.fn(), social: vi.fn() },
    getSession: vi.fn(),
  },
}));

function renderSignIn() {
  render(
    <MemoryRouter initialEntries={["/signin"]}>
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        {/* Catch the post-submit navigate("/") so react-router doesn't warn. */}
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.mocked(authClient.signIn.email).mockReset();
  vi.mocked(authClient.signIn.social).mockReset();
  vi.mocked(authClient.getSession).mockReset();
});

describe("SignIn", () => {
  it("submits email and password to authClient.signIn.email", async () => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({ error: null } as never);
    vi.mocked(authClient.getSession).mockResolvedValue({} as never);
    renderSignIn();

    await userEvent.type(screen.getByLabelText("Email"), "a@b.com");
    await userEvent.type(screen.getByLabelText("Password"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(authClient.signIn.email).toHaveBeenCalledWith({ email: "a@b.com", password: "hunter2" });
  });

  it("shows an alert when sign-in fails", async () => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({
      error: { message: "Invalid credentials" },
    } as never);
    renderSignIn();

    await userEvent.type(screen.getByLabelText("Email"), "a@b.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid credentials")).toBeInTheDocument();
  });

  it("triggers Google sign-in on button click", async () => {
    renderSignIn();
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(authClient.signIn.social).toHaveBeenCalledWith({ provider: "google", callbackURL: "/" });
  });
});
