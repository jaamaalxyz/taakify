// Test/E2E-only in-memory capture of the plaintext OTP at send time.
//
// This exists because auth.ts configures the email-otp plugin with
// `storeOTP: "hashed"` (a deliberate security choice from Task 2) — once
// stored, the plaintext is not recoverable from better-auth's own storage,
// so `auth.api.getVerificationOTP` (the mechanism Task 3's plan originally
// specified) throws "OTP is hashed, cannot return the plain text OTP" for
// every request. Capturing the plaintext here, at the one point
// (`sendOtpEmail`) where it still exists in memory, lets test-only.ts hand
// it back to E2E tests without weakening the real hashed-storage security
// property at all.
//
// Gated the same way as test-only.ts's route: never populated outside
// non-production environments, so nothing here can leak a plaintext OTP in
// production even if this module were reachable there.
type OtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

const pending = new Map<string, string>();

function key(email: string, type: string): string {
  return `${type}:${email}`;
}

export function recordOtp(email: string, type: OtpType, otp: string): void {
  if (process.env.NODE_ENV === "production") return;
  pending.set(key(email, type), otp);
}

export function getPendingOtp(email: string, type: string): string | null {
  if (process.env.NODE_ENV === "production") return null;
  return pending.get(key(email, type)) ?? null;
}
