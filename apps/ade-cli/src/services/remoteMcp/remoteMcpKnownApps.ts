import {
  REMOTE_MCP_KNOWN_APP_LABELS,
  type RemoteMcpKnownApp,
} from "../../../../desktop/src/shared/types/remoteMcp";

/**
 * The AI apps ADE MCP knows by name, recognised at sign-in.
 *
 * The return address an app signs in with says more than the name it
 * registered: Cursor publishes one client ("Cursor") whose return addresses
 * cover Cursor itself, its cloud agents, Grok Bot and grok.com, so a sign-in
 * from Grok Bot registers as "Cursor". The redirect URI used at authorize is
 * checked first. The registered name decides only for apps on a local
 * address (CLIs and desktop apps listen on loopback) or an app scheme: any
 * website can register any name, so a hosted page ADE does not list keeps the
 * name it registered and is shown with its real host, never as a known app.
 */

export type RecognisedRemoteMcpApp = { app: RemoteMcpKnownApp; name: string };

function known(app: RemoteMcpKnownApp, name: string = REMOTE_MCP_KNOWN_APP_LABELS[app]): RecognisedRemoteMcpApp {
  return { app, name };
}

/** Hosted apps, by the host (and path) they return to. Checked in order. */
const BY_REDIRECT: ReadonlyArray<{ host: string; path?: string; recognised: RecognisedRemoteMcpApp }> = [
  { host: "grok.com", recognised: known("grok") },
  { host: "www.cursor.com", path: "/bot/", recognised: known("grok-bot") },
  { host: "cursor.com", path: "/bot/", recognised: known("grok-bot") },
  // Cursor's own client, signed in from a cloud agent rather than the editor.
  { host: "www.cursor.com", path: "/agents/", recognised: known("cursor", "Cursor cloud agent") },
  { host: "cursor.com", path: "/agents/", recognised: known("cursor", "Cursor cloud agent") },
  { host: "claude.ai", recognised: known("claude") },
  { host: "chatgpt.com", recognised: known("chatgpt") },
  { host: "chat.openai.com", recognised: known("chatgpt") },
  { host: "www.perplexity.ai", recognised: known("perplexity") },
  { host: "perplexity.ai", recognised: known("perplexity") },
  { host: "chat.mistral.ai", recognised: known("le-chat") },
];

/** App schemes (`cursor://…`). */
const BY_SCHEME: Readonly<Record<string, RemoteMcpKnownApp>> = {
  "cursor:": "cursor",
  "vscode:": "vscode",
  "vscode-insiders:": "vscode",
  "windsurf:": "windsurf",
  "zed:": "zed",
  "raycast:": "raycast",
  "goose:": "goose",
};

/** Registered names (lowercase, first match wins), for apps on a local address or an app scheme. */
const BY_NAME: ReadonlyArray<{ pattern: RegExp; app: RemoteMcpKnownApp }> = [
  { pattern: /\bclaude code\b/, app: "claude-code" },
  { pattern: /\bclaude\b/, app: "claude" },
  { pattern: /\bcodex\b/, app: "codex" },
  { pattern: /\bchatgpt\b/, app: "chatgpt" },
  { pattern: /\bgemini\b/, app: "gemini-cli" },
  { pattern: /\b(?:visual studio code|vs ?code|copilot)\b/, app: "vscode" },
  { pattern: /\bcursor\b/, app: "cursor" },
  { pattern: /\b(?:windsurf|devin)\b/, app: "windsurf" },
  { pattern: /\bzed\b/, app: "zed" },
  { pattern: /\bgoose\b/, app: "goose" },
  { pattern: /\bopencode\b/, app: "opencode" },
  { pattern: /\bamp\b/, app: "amp" },
  { pattern: /\b(?:factory|droid)\b/, app: "factory" },
  { pattern: /\braycast\b/, app: "raycast" },
  { pattern: /\b(?:le chat|mistral)\b/, app: "le-chat" },
  { pattern: /\bperplexity\b/, app: "perplexity" },
  { pattern: /\bgrok\b/, app: "grok" },
];

function byName(clientName: string): RecognisedRemoteMcpApp | null {
  const lower = clientName.toLowerCase();
  const match = BY_NAME.find((entry) => entry.pattern.test(lower));
  return match ? known(match.app) : null;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/** The app behind a sign-in, from the redirect URI it used and the name it registered; null when unknown. */
export function recogniseRemoteMcpApp(redirectUri: string, clientName: string): RecognisedRemoteMcpApp | null {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (scheme === "https:") {
    const path = url.pathname.toLowerCase();
    // Another hosted page is not named by what it registered: it shows as itself.
    return BY_REDIRECT.find((entry) => entry.host === host && (!entry.path || path.startsWith(entry.path)))?.recognised ?? null;
  }
  if (scheme === "http:") return isLoopbackHost(host) ? byName(clientName) : null;
  const app = BY_SCHEME[scheme];
  return app ? known(app) : byName(clientName);
}

/**
 * The app of a connection stored before sign-ins recorded it, from what the
 * record kept: the redirect host (`redirectDisplayHost`: `host[:port]` for
 * web addresses, `scheme://host` or `scheme:` for app schemes) and the label.
 * `www.cursor.com` is left unknown, because Cursor's cloud agents and Grok
 * Bot both return there; another web host is never named by its label.
 */
export function inferRemoteMcpAppFromRecord(redirectHost: string | null, label: string): RemoteMcpKnownApp | null {
  const host = (redirectHost ?? "").toLowerCase();
  if (host === "www.cursor.com" || host === "cursor.com") return null;
  const hosted = BY_REDIRECT.find((entry) => !entry.path && entry.host === host);
  if (hosted) return hosted.recognised.app;
  // `scheme://host`, or a bare `scheme:` for a host-less app address
  // (`myapp:/callback`); never `localhost:3000`, whose colon is a port's.
  const scheme = /^([a-z][a-z0-9+.-]*:)(?:\/\/|$)/.exec(host)?.[1];
  if (scheme) return BY_SCHEME[scheme] ?? byName(label)?.app ?? null;
  // `localhost:3000`, `[::1]:3000`: a local app, named by its label.
  const hostname = host.replace(/:\d+$/, "");
  return isLoopbackHost(hostname) ? byName(label)?.app ?? null : null;
}
