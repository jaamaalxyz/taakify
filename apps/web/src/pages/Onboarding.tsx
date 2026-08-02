import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";

export function Onboarding() {
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name"));
    try {
      await api("/api/households", { method: "POST", body: JSON.stringify({ name }) });
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main>
      <h1>Name your library</h1>
      <p className="muted">This is your household's shared bookshelf. You can invite family after.</p>
      <form onSubmit={onSubmit}>
        <input name="name" placeholder="e.g. Our Family Library" required />
        <button type="submit">Create library</button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
