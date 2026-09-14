import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Logo } from "../components/Logo.js";

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
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <Logo className="h-10 w-10" />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Name your library</CardTitle>
          <CardDescription>This is your household's shared bookshelf. You can invite family after.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Library name</Label>
              <Input id="name" name="name" placeholder="e.g. Our Family Library" required />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full">
              Create library
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
