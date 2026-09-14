// Real OTP delivery via Resend when configured; otherwise logs to the
// console so local dev and the test suite never need a real Resend
// account. Mirrors the existing googleEnabled env-gating pattern in
// apps/api/src/auth.ts -- a missing key means "not configured", not an
// error, but a *present* key with no EMAIL_FROM is a misconfiguration and
// fails loudly rather than silently dropping the email.
import { recordOtp } from "./otp-capture.js";

type OtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

const SUBJECTS: Record<OtpType, string> = {
  "sign-in": "Your Taakify sign-in code",
  "email-verification": "Verify your Taakify email",
  "forget-password": "Your Taakify password reset code",
  "change-email": "Confirm your new Taakify email",
};

export async function sendOtpEmail(data: { email: string; otp: string; type: OtpType }): Promise<void> {
  recordOtp(data.email, data.type, data.otp);
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[email-otp] ${data.type} code for ${data.email}: ${data.otp}`);
    return;
  }
  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new Error("EMAIL_FROM is not set (required whenever RESEND_API_KEY is set)");
  }
  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: data.email,
    subject: SUBJECTS[data.type],
    text: `Your code is ${data.otp}. It expires in 5 minutes.`,
  });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
}
