/**
 * Formats an ISO date (YYYY-MM-DD) as a human-readable string, e.g.
 * "March 5, 2026". Parsed as UTC so the output is deterministic across
 * timezones (important for SSG — the same HTML is generated everywhere).
 */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
