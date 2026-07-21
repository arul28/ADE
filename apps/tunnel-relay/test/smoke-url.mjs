/**
 * Manual smoke tests may only target a loopback Wrangler instance. Keep this
 * check before any socket or fetch work so a copied command cannot touch a
 * production relay (or any other remote host).
 */
export function requireLoopbackRelayUrl(raw) {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "localhost"
    || hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);

  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopback) {
    throw new Error(`tunnel relay smoke is local-only; refusing ${url.origin}`);
  }

  return url.toString().replace(/\/+$/, "");
}
