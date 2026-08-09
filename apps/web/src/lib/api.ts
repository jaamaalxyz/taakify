// Thrown by `api()` for any non-2xx response. Carries the HTTP status
// alongside the server's message so callers (notably `friendlyError()` in
// `error-messages.ts`) can branch on the stable status code instead of
// parsing message text — response bodies aren't a contract, status codes
// are. `.message` still works exactly like the plain `Error` this replaces,
// so any existing `(err as Error).message` read keeps working unchanged.
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

export type Me = {
  user: { id: string; email: string; name: string };
  memberships: { household_id: string; role: string; household_name: string }[];
};
