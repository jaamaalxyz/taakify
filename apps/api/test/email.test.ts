import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("sendOtpEmail", () => {
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.EMAIL_FROM;

  afterEach(() => {
    process.env.RESEND_API_KEY = originalApiKey;
    process.env.EMAIL_FROM = originalFrom;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("logs the OTP to the console instead of sending when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    const { sendOtpEmail } = await import("../src/lib/email.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendOtpEmail({ email: "a@b.com", otp: "123456", type: "sign-in" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("123456"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("a@b.com"));
  });

  it("throws if RESEND_API_KEY is set but EMAIL_FROM is not", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.EMAIL_FROM;
    const { sendOtpEmail } = await import("../src/lib/email.js");
    await expect(sendOtpEmail({ email: "a@b.com", otp: "123456", type: "sign-in" })).rejects.toThrow(
      "EMAIL_FROM"
    );
  });
});
