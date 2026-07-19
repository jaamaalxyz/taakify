// Only allow in-app absolute paths — rejects external and protocol-relative
// ("//evil.com") URLs so a tampered ?next= can't become an open redirect.
export function safeNext(raw: string | null, fallback: string): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}
