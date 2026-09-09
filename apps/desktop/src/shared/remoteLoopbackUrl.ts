/**
 * Loopback URL localization for a chat pinned to another machine.
 *
 * The built-in browser is a `WebContentsView` owned by THIS desktop's main
 * process, so a chat pinned to a remote machine still drives the browser you
 * are looking at. `http://localhost:3000` therefore means two different
 * servers depending on who typed it: the agent (or the dev server) means the
 * pinned machine's port 3000, and this desktop's loopback is a different box
 * entirely — usually nothing at all, sometimes a *different* project's dev
 * server, which is the dangerous case.
 *
 * So every loopback URL asked for on a remote pin is rewritten onto a
 * per-(machine, port) TCP port-forward before it loads, and the remote origin
 * the user asked for is what the URL bar keeps showing. Non-loopback URLs are
 * reachable from either machine and pass through untouched.
 *
 * Pure string/URL logic only: no Electron, no IPC, no platform branches (the
 * forward itself is plain TCP, so Windows behaves exactly like macOS).
 */

/** A forward that is live for one (machine, remote port) pair. */
export type RemoteLoopbackTunnel = {
  /** Stable per-machine key — the remote runtime target id. */
  machineKey: string;
  /** Human name for the badge ("MacBook Pro (97)"). */
  machineLabel: string;
  /** The port the human/agent asked for, on the pinned machine. */
  remotePort: number;
  /** The origin the user asked for, e.g. `http://localhost:3000`. */
  remoteOrigin: string;
  /** The ephemeral loopback port this desktop listens on. */
  localPort: number;
  /** The origin the WebContentsView actually loads, e.g. `http://127.0.0.1:52413`. */
  localOrigin: string;
};

export type LocalizedRemoteUrl = {
  /** The URL to actually navigate to. */
  url: string;
  /** Null when the URL needed no tunnel (not loopback, or not a remote pin). */
  forward: RemoteLoopbackTunnel | null;
};

const DEFAULT_PORT_BY_PROTOCOL: Record<string, number> = {
  "http:": 80,
  "https:": 443,
};

/**
 * Above this, a loopback port was handed out by the OS rather than chosen.
 *
 * A chat pinned to another machine reaches that machine's `localhost:3000`
 * through an ephemeral TCP forward, so the browser really loads something like
 * `http://127.0.0.1:52413`. That origin dies with the transport, and the OS is
 * free to hand the same number to an unrelated local server tomorrow — so
 * remembering it — or fetching from it — would address something that is, at
 * best, not the page it claims to be. A tunneled tab records the tunnel's remote-origin
 * display URL instead (the panel already shows that URL everywhere); when the
 * mapping is unknown the raw forward origin reaches the caller and is refused.
 *
 * A dev server the human actually chose — 3000, 5173, 8080 — is well below
 * this, so ordinary local browsing is unaffected.
 */
export const EPHEMERAL_LOOPBACK_PORT_MIN = 32_768;

/**
 * `0.0.0.0` is included deliberately: dev servers print it as their bind
 * address, so agents paste it, and on the pinned machine it resolves to that
 * machine's own stack exactly like `127.0.0.1` does.
 */
export function isLoopbackHostname(value: string | null | undefined): boolean {
  const host = (value ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "[::]" || host === "::") return true;
  if (host === "[::1]" || host === "::1") return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Parse a URL only if it is an http(s) loopback URL with a usable port. */
export function parseLoopbackUrl(
  value: string | null | undefined,
): { url: URL; port: number } | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!isLoopbackHostname(url.hostname)) return null;
  const port = url.port
    ? Number(url.port)
    : DEFAULT_PORT_BY_PROTOCOL[url.protocol] ?? 0;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { url, port };
}

/** Rewrite host+port, preserving protocol, path, query and hash. */
export function rewriteUrlHostPort(
  value: string,
  hostname: string,
  port: number,
): string {
  const url = new URL(value);
  url.hostname = hostname;
  url.port = String(port);
  return url.toString();
}

/** `http://localhost:3000` for a parsed loopback URL, without path or query. */
export function loopbackOriginLabel(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/**
 * The approval / grant key for one (machine, remote port) pair.
 *
 * The agent picks the port, so a machine-wide `portForward` grant is not
 * consent for *this* port: a lane approved for the dev server on 3000 has not
 * approved a database admin console on 8080.
 */
export function remoteTunnelApprovalKey(machineKey: string, remotePort: number): string {
  return `${machineKey.trim()}:${remotePort}`;
}

/**
 * Does `url` still live on the tunnel's local origin?
 *
 * A tab that navigates within the forwarded origin keeps showing the remote
 * origin; one that leaves for a real site has left the tunnel and the mapping
 * is dropped.
 */
export function urlBelongsToTunnel(
  url: string | null | undefined,
  tunnel: Pick<RemoteLoopbackTunnel, "localOrigin">,
): boolean {
  const text = (url ?? "").trim();
  if (!text) return false;
  try {
    return `${new URL(text).protocol}//${new URL(text).host}` === tunnel.localOrigin;
  } catch {
    return false;
  }
}

/**
 * Present a tunneled URL as the remote origin the human asked for. The local
 * forward port is an implementation detail and changes every session, so it
 * must never be what the URL bar, a tab title, or an agent observation says.
 */
export function displayUrlForTunnel(
  url: string | null | undefined,
  tunnel: RemoteLoopbackTunnel,
): string | null {
  const text = (url ?? "").trim();
  if (!text) return null;
  if (!urlBelongsToTunnel(text, tunnel)) return null;
  try {
    const parsed = new URL(text);
    const remote = new URL(tunnel.remoteOrigin);
    parsed.protocol = remote.protocol;
    parsed.hostname = remote.hostname;
    parsed.port = remote.port;
    return parsed.toString();
  } catch {
    return null;
  }
}
