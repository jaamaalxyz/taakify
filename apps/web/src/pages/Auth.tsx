import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Mail, KeyRound } from "lucide-react";
import { authClient } from "../lib/auth.js";
import { safeNext } from "../lib/safe-next.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Logo } from "../components/Logo.js";

export function Auth() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  async function sendCode() {
    setError("");
    setSending(true);
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
      if (error) return setError(error.message ?? "Couldn't send the code");
      setStep("code");
    } finally {
      setSending(false);
    }
  }

  async function onEmailSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await sendCode();
  }

  async function onCodeSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setVerifying(true);
    try {
      const { error } = await authClient.signIn.emailOtp({ email, otp: code, name });
      if (error) return setError(error.message ?? "That code didn't work");
      await authClient.getSession();
      navigate(safeNext(searchParams.get("next"), "/"));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <Logo className="h-10 w-10" />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{step === "email" ? "Sign in to Taakify" : "Enter your code"}</CardTitle>
          <CardDescription>
            {step === "email"
              ? "One code, sent to your email — no password to remember."
              : `We sent a 6-digit code to ${email}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {step === "email" ? (
            <>
              <form onSubmit={onEmailSubmit} className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      placeholder="you@example.com"
                      required
                      className="pl-9"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="name">Your name (only needed the first time)</Label>
                  <Input
                    id="name"
                    placeholder="Ada Lovelace"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" className="w-full" disabled={sending}>
                  {sending ? "Sending…" : "Continue with email"}
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
            </>
          ) : (
            <form onSubmit={onCodeSubmit} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="code">6-digit code</Label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    required
                    className="pl-9"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </div>
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={verifying}>
                {verifying ? "Verifying…" : "Verify"}
              </Button>
              <div className="flex justify-between text-sm text-muted-foreground">
                <button
                  type="button"
                  className="underline-offset-4 hover:underline"
                  onClick={() => setStep("email")}
                >
                  Use a different email
                </button>
                <button type="button" className="underline-offset-4 hover:underline" onClick={sendCode}>
                  Resend code
                </button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
