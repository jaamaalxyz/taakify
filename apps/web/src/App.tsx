import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { authClient } from "./lib/auth.js";
import { SignUp } from "./pages/SignUp.js";
import { SignIn } from "./pages/SignIn.js";
import { Onboarding } from "./pages/Onboarding.js";
import { InviteAccept } from "./pages/InviteAccept.js";
import { Landing } from "./pages/Landing.js";
import { Home } from "./pages/Home.js";
import { Library } from "./pages/Library.js";
import { Add } from "./pages/Add.js";
import { Import } from "./pages/Import.js";
import { BookDetail } from "./pages/BookDetail.js";
import { Loans } from "./pages/Loans.js";
import { Bookcases } from "./pages/Bookcases.js";
import { Profile } from "./pages/Profile.js";
import { AppShell } from "./components/AppShell.js";
import { Skeleton } from "./components/ui/skeleton.js";
import { useTheme } from "./lib/use-theme.js";

export function App() {
  useTheme();
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();

  if (isPending)
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Skeleton className="h-8 w-40" />
      </main>
    );

  const authed = Boolean(session);
  // Only the root path gets the landing page when unauthenticated; every
  // other authed-only route keeps bouncing to /signin as before.
  const unauthedRootElement = location.pathname === "/" ? <Landing /> : <Navigate to="/signin" />;

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
        here — / (Home), /library, /library/:bookId, /add, /import, /loans,
        /bookcases, and /profile. When unauthenticated, / shows Landing
        (spec §6); every other path here still bounces to /signin.
      */}
      <Route element={authed ? <AppShell /> : unauthedRootElement}>
        <Route path="/" element={<Home />} />
        <Route path="/library" element={<Library />} />
        <Route path="/library/:bookId" element={<BookDetail />} />
        <Route path="/add" element={<Add />} />
        <Route path="/import" element={<Import />} />
        <Route path="/loans" element={<Loans />} />
        <Route path="/bookcases" element={<Bookcases />} />
        <Route path="/profile" element={<Profile />} />
      </Route>
    </Routes>
  );
}
