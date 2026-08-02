import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth.js";
import { safeNext } from "../lib/safe-next.js";

export function SignIn() {
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const { error } = await authClient.signIn.email({
      email: String(data.get("email")),
      password: String(data.get("password")),
    });
    if (error) return setError(error.message ?? "Sign-in failed");
    await authClient.getSession();
    navigate(safeNext(searchParams.get("next"), "/"));
  }

  return (
    <main>
      <h1>Sign in to Taakify</h1>
      <form onSubmit={onSubmit}>
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Sign in</button>
        {error && <p className="error">{error}</p>}
      </form>
      <button
        type="button"
        onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/" })}
      >
        Continue with Google
      </button>
      <p className="muted">New here? <Link to="/signup">Create an account</Link></p>
    </main>
  );
}
