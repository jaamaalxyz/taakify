import { Link } from "react-router-dom";
import { Button } from "../components/ui/button.js";
import { Logo } from "../components/Logo.js";

const BENEFITS = [
  {
    title: "Catalog every shelf",
    description: "Add books in seconds and always know what you own, and where.",
  },
  {
    title: "See what everyone's reading",
    description: "One shared shelf for your whole household, no more asking who's got what.",
  },
  {
    title: "Never lose a lent book",
    description: "Track who borrowed what and when it's due, so nothing quietly disappears.",
  },
];

export function Landing() {
  return (
    <main className="flex flex-col items-center text-center">
      <section className="flex flex-col items-center gap-3 p-4 py-20">
        <Logo className="h-10 w-10" />
        <h1 className="font-serif text-4xl font-bold tracking-tight">Taakify</h1>
        <p className="text-lg font-semibold">A private library for your household. Works even offline.</p>
      </section>

      <section className="grid w-full max-w-3xl gap-8 p-4 pb-20 sm:grid-cols-3">
        {BENEFITS.map((benefit) => (
          <div key={benefit.title}>
            <h2 className="font-serif text-xl font-bold">{benefit.title}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{benefit.description}</p>
          </div>
        ))}
      </section>

      <section className="flex w-full flex-col items-center gap-5 border-t p-8 py-20">
        <h2 className="max-w-md font-serif text-2xl font-bold">
          Your books. Your shelves. Your household.
        </h2>
        <div className="flex w-full max-w-xs flex-col gap-3">
          <Button asChild className="w-full">
            <Link to="/signup">Sign up</Link>
          </Button>
          <Button asChild variant="outline" className="w-full">
            <Link to="/signin">Sign in</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
