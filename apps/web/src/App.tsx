import { Routes, Route, Navigate } from "react-router-dom";
import { authClient } from "./lib/auth.js";
import { SignUp } from "./pages/SignUp.js";
import { SignIn } from "./pages/SignIn.js";
import { Onboarding } from "./pages/Onboarding.js";
import { InviteAccept } from "./pages/InviteAccept.js";
import { Library } from "./pages/Library.js";
import { Add } from "./pages/Add.js";
import { BookDetail } from "./pages/BookDetail.js";
import { Loans } from "./pages/Loans.js";
import { Profile } from "./pages/Profile.js";
import { AppShell } from "./components/AppShell.js";
import { Skeleton } from "./components/ui/skeleton.js";
import { useTheme } from "./lib/use-theme.js";

export function App() {
  useTheme();
  const { data: session, isPending } = authClient.useSession();

  if (isPending)
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Skeleton className="h-8 w-40" />
      </main>
    );

  const authed = Boolean(session);

  return (
    <Routes>
      <Route path="/signup" element={authed ? <Navigate to="/" /> : <SignUp />} />
      <Route path="/signin" element={authed ? <Navigate to="/" /> : <SignIn />} />
      <Route path="/invite/:token" element={<InviteAccept authed={authed} />} />
      <Route path="/onboarding" element={authed ? <Onboarding /> : <Navigate to="/signin" />} />
      {/*
        Authed routes nest under AppShell, which owns fetching /api/me and
        redirecting to /onboarding when the user has no household yet (see
        lib/household-context.tsx). Only routes for pages that exist land
        here — /library, /library/:bookId, /add, /loans, and /profile.
        /bookcases is added by Task 11's next sub-step as its page is built.
      */}
      <Route element={authed ? <AppShell /> : <Navigate to="/signin" />}>
        <Route path="/" element={<Navigate to="/library" />} />
        <Route path="/library" element={<Library />} />
        <Route path="/library/:bookId" element={<BookDetail />} />
        <Route path="/add" element={<Add />} />
        <Route path="/loans" element={<Loans />} />
        <Route path="/profile" element={<Profile />} />
      </Route>
    </Routes>
  );
}
