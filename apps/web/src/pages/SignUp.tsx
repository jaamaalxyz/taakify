import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth.js";
import { safeNext } from "../lib/safe-next.js";

export function SignUp() {
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const { error } = await authClient.signUp.email({
      name: String(data.get("name")),
      email: String(data.get("email")),
      password: String(data.get("password")),
    });
    if (error) return setError(error.message ?? "Sign-up failed");
    // useSession updates async (better-auth refetches on a delayed signal);
    // settle it before navigating so the auth gate doesn't bounce to /signin.
    await authClient.getSession();
    navigate(safeNext(searchParams.get("next"), "/onboarding"));
  }

  return (
    <main>
      <h1>Create your Taakify account</h1>
      <form onSubmit={onSubmit}>
        <input name="name" placeholder="Your name" required />
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password (8+ chars)" minLength={8} required />
        <button type="submit">Sign up</button>
        {error && <p className="error">{error}</p>}
      </form>
      <button
        type="button"
        onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/" })}
      >
        Continue with Google
      </button>
      <p className="muted">Already have an account? <Link to="/signin">Sign in</Link></p>
    </main>
  );
}
