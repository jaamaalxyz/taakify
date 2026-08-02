import { Routes, Route, Navigate } from "react-router-dom";
import { authClient } from "./lib/auth.js";
import { SignUp } from "./pages/SignUp.js";
import { SignIn } from "./pages/SignIn.js";
import { Onboarding } from "./pages/Onboarding.js";
import { InviteAccept } from "./pages/InviteAccept.js";
import { Home } from "./pages/Home.js";
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
      <Route path="/" element={authed ? <Home /> : <Navigate to="/signin" />} />
    </Routes>
  );
}
