import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { Button } from "../components/ui/button.js";

export function Landing() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 p-4 text-center">
      <div className="flex flex-col items-center gap-3">
        <BookOpen className="h-10 w-10 text-primary" aria-hidden="true" />
        <h1 className="text-3xl font-semibold tracking-tight">Taakify</h1>
        <p className="max-w-sm text-muted-foreground">
          Track what your household is reading, catalog your shelves, and
          remember who borrowed what — all in one shared family library.
        </p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-3">
        <Button asChild className="w-full">
          <Link to="/signup">Sign up</Link>
        </Button>
        <Button asChild variant="outline" className="w-full">
          <Link to="/signin">Sign in</Link>
        </Button>
      </div>
    </main>
  );
}
