function normalizeHostname(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^\[|\]$/g, "") ?? ""
  );
}

export function isTailnetHostname(value: string | null | undefined): boolean {
  const hostname = normalizeHostname(value);
  if (hostname.endsWith(".ts.net")) return true;
  const match = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const second = Number.parseInt(match[1] ?? "", 10);
  return second >= 64 && second <= 127;
}
