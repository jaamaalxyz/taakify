import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { User, Mail, Lock } from "lucide-react";
import { authClient } from "../lib/auth.js";
import { safeNext } from "../lib/safe-next.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";

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
    await authClient.getSession();
    navigate(safeNext(searchParams.get("next"), "/onboarding"));
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create your Taakify account</CardTitle>
          <CardDescription>Start your family's shared bookshelf.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Your name</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="name" name="name" placeholder="Ada Lovelace" required className="pl-9" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="email" name="email" type="email" placeholder="you@example.com" required className="pl-9" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  name="password"
                  type="password"
                  placeholder="8+ characters"
                  minLength={8}
                  required
                  className="pl-9"
                />
              </div>
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full">
              Sign up
            </Button>
          </form>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/" })}
          >
            Continue with Google
          </Button>
        </CardContent>
        <CardFooter className="justify-center text-sm text-muted-foreground">
          Already have an account?&nbsp;
          <Link to="/signin" className="text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
        </CardFooter>
      </Card>
    </main>
  );
}
