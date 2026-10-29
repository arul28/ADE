import type { RemoteMcpKnownApp } from "../../../../desktop/src/shared/types/remoteMcp";

/**
 * The AI apps ADE MCP knows by name, recognised at sign-in.
 *
 * The return address an app signs in with says more than the name it
 * registered: Cursor publishes one client ("Cursor") whose return addresses
 * cover Cursor itself, its cloud agents, Grok Bot and grok.com, so a sign-in
 * from Grok Bot registers as "Cursor". The redirect URI used at authorize is
 * checked first; the registered name decides only for apps on a local
 * address (CLIs and desktop apps listen on loopback).
 */

export type RecognisedRemoteMcpApp = { app: RemoteMcpKnownApp; name: string };

const KNOWN_APPS: ReadonlySet<string> = new Set<RemoteMcpKnownApp>([
  "claude", "claude-code", "chatgpt", "codex", "grok", "grok-bot", "cursor", "vscode", "gemini-cli", "perplexity",
  "le-chat", "windsurf", "zed", "goose", "opencode", "amp", "factory", "raycast",
]);

export function isRemoteMcpKnownApp(value: unknown): value is RemoteMcpKnownApp {
  return typeof value === "string" && KNOWN_APPS.has(value);
}

/** Hosted apps, by the host (and path) they return to. Checked in order. */
const BY_REDIRECT: ReadonlyArray<{ host: string; path?: string; app: RemoteMcpKnownApp; name: string }> = [
  { host: "grok.com", app: "grok", name: "Grok" },
  { host: "www.cursor.com", path: "/bot/", app: "grok-bot", name: "Grok Bot" },
  { host: "cursor.com", path: "/bot/", app: "grok-bot", name: "Grok Bot" },
  { host: "www.cursor.com", path: "/agents/", app: "cursor", name: "Cursor cloud agent" },
  { host: "cursor.com", path: "/agents/", app: "cursor", name: "Cursor cloud agent" },
  { host: "claude.ai", app: "claude", name: "Claude" },
  { host: "chatgpt.com", app: "chatgpt", name: "ChatGPT" },
  { host: "chat.openai.com", app: "chatgpt", name: "ChatGPT" },
  { host: "www.perplexity.ai", app: "perplexity", name: "Perplexity" },
  { host: "perplexity.ai", app: "perplexity", name: "Perplexity" },
  { host: "chat.mistral.ai", app: "le-chat", name: "Le Chat" },
];

/** App schemes (`cursor://…`). */
const BY_SCHEME: Readonly<Record<string, RecognisedRemoteMcpApp>> = {
  "cursor:": { app: "cursor", name: "Cursor" },
  "vscode:": { app: "vscode", name: "VS Code" },
  "vscode-insiders:": { app: "vscode", name: "VS Code" },
  "windsurf:": { app: "windsurf", name: "Windsurf" },
  "zed:": { app: "zed", name: "Zed" },
  "raycast:": { app: "raycast", name: "Raycast" },
  "goose:": { app: "goose", name: "Goose" },
};

/** Registered names (lowercase, first match wins), for apps that return to a local address. */
const BY_NAME: ReadonlyArray<{ pattern: RegExp; app: RemoteMcpKnownApp; name: string }> = [
  { pattern: /\bclaude code\b/, app: "claude-code", name: "Claude Code" },
  { pattern: /\bclaude\b/, app: "claude", name: "Claude" },
  { pattern: /\bcodex\b/, app: "codex", name: "Codex" },
  { pattern: /\bchatgpt\b/, app: "chatgpt", name: "ChatGPT" },
  { pattern: /\bgemini\b/, app: "gemini-cli", name: "Gemini CLI" },
  { pattern: /\b(?:visual studio code|vs ?code|copilot)\b/, app: "vscode", name: "VS Code" },
  { pattern: /\bcursor\b/, app: "cursor", name: "Cursor" },
  { pattern: /\b(?:windsurf|devin)\b/, app: "windsurf", name: "Windsurf" },
  { pattern: /\bzed\b/, app: "zed", name: "Zed" },
  { pattern: /\bgoose\b/, app: "goose", name: "Goose" },
  { pattern: /\bopencode\b/, app: "opencode", name: "OpenCode" },
  { pattern: /\bamp\b/, app: "amp", name: "Amp" },
  { pattern: /\b(?:factory|droid)\b/, app: "factory", name: "Factory Droid" },
  { pattern: /\braycast\b/, app: "raycast", name: "Raycast" },
  { pattern: /\b(?:le chat|mistral)\b/, app: "le-chat", name: "Le Chat" },
  { pattern: /\bperplexity\b/, app: "perplexity", name: "Perplexity" },
  { pattern: /\bgrok\b/, app: "grok", name: "Grok" },
];

function byName(clientName: string): RecognisedRemoteMcpApp | null {
  const lower = clientName.toLowerCase();
  const match = BY_NAME.find((entry) => entry.pattern.test(lower));
  return match ? { app: match.app, name: match.name } : null;
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
    return byName(clientName);
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme === "https:") {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const hit = BY_REDIRECT.find((entry) => entry.host === host && (!entry.path || path.startsWith(entry.path)));
    if (hit) return { app: hit.app, name: hit.name };
    // Another hosted page: its own registered name is all there is.
    return byName(clientName);
  }
  if (scheme === "http:" && isLoopbackHost(url.hostname.toLowerCase())) return byName(clientName);
  return BY_SCHEME[scheme] ?? byName(clientName);
}

/**
 * The app of a connection stored before sign-ins recorded it, from what the
 * record kept: the redirect host and the label. `www.cursor.com` is left
 * unknown, because Cursor's cloud agents and Grok Bot both return there.
 */
export function inferRemoteMcpAppFromRecord(redirectHost: string | null, label: string): RemoteMcpKnownApp | null {
  const host = (redirectHost ?? "").toLowerCase();
  if (host === "www.cursor.com" || host === "cursor.com") return null;
  const hosted = BY_REDIRECT.find((entry) => !entry.path && entry.host === host);
  if (hosted) return hosted.app;
  const scheme = /^([a-z][a-z0-9+.-]*:)\/\//.exec(host)?.[1];
  if (scheme && BY_SCHEME[scheme]) return BY_SCHEME[scheme]!.app;
  return byName(label)?.app ?? null;
}
