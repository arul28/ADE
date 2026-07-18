export function isAllowedOpenCodeOAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol !== "http:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "localhost"
      || hostname === "[::1]"
      || hostname === "::1"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}
