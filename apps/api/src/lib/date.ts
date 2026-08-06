// pg's default DATE parser returns a JS Date at local midnight; letting
// JSON.stringify serialize it via toISOString() converts to UTC and can
// shift the calendar day (visible in this repo's local -6h test env, and a
// real bug in any +UTC server timezone). Format explicitly from the local
// date components pg used to build the Date, instead.
export function dateStr(d: unknown): string | null {
  if (!(d instanceof Date)) return (d as string | null) ?? null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
