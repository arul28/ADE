/**
 * The AI apps ADE MCP knows how to set up: each one's logo, how it connects
 * (sign in with the ADE account, a token, or both), and its setup steps with
 * the real menu paths. Researched per app (see docs/features/ade-mcp).
 *
 * Logos are the makers' own marks, drawn inline (lobehub icons) or from the
 * bundled editor logos, so nothing loads over the network.
 */
import type { ReactNode } from "react";
import {
  Amp,
  Claude,
  ClaudeCode,
  Codex,
  Cursor,
  GeminiCLI,
  Goose,
  Grok,
  Mistral,
  OpenAI,
  OpenCode,
  Perplexity,
  Windsurf,
} from "@lobehub/icons";
import { Command, Key, PlugsConnected, Robot } from "@phosphor-icons/react";
import type { RemoteMcpKnownApp } from "../../../../shared/types/remoteMcp";
import { DroidLogo } from "../../shared/ProviderLogos";
import vscodeLogoSrc from "../../../assets/editor-logos/vscode.svg";
import zedLogoSrc from "../../../assets/editor-logos/zed.svg";

/** A logo for a known app, a token, or an app ADE did not recognise. */
export type McpLogoId = RemoteMcpKnownApp | "token" | "other";

type LobeAvatar = (props: { size: number; shape?: "circle" | "square" }) => ReactNode;

const LOBE: Partial<Record<RemoteMcpKnownApp, LobeAvatar>> = {
  claude: Claude.Avatar,
  "claude-code": ClaudeCode.Avatar,
  chatgpt: OpenAI.Avatar,
  codex: Codex.Avatar,
  grok: Grok.Avatar,
  "grok-bot": Grok.Avatar,
  cursor: Cursor.Avatar,
  perplexity: Perplexity.Avatar,
  "le-chat": Mistral.Avatar,
  windsurf: Windsurf.Avatar,
  goose: Goose.Avatar,
  opencode: OpenCode.Avatar,
  amp: Amp.Avatar,
};

/** Marks that are not in the icon set: a tile in the maker's colour. */
function customMark(app: McpLogoId, size: number): { background: string; mark: ReactNode } | null {
  const inner = Math.round(size * 0.62);
  switch (app) {
    case "gemini-cli":
      // The icon set's Gemini CLI tile draws its mark too dark to see; its
      // mark in white on Gemini's own gradient reads on every theme.
      return { background: "linear-gradient(135deg, #4285F4, #9B72CB 55%, #D96570)", mark: <GeminiCLI size={inner} color="#fff" /> };
    case "vscode":
      return { background: "#1F1F1F", mark: <img src={vscodeLogoSrc} width={inner} height={inner} alt="" draggable={false} /> };
    case "zed":
      return { background: "#0E0E10", mark: <img src={zedLogoSrc} width={inner} height={inner} alt="" draggable={false} /> };
    case "factory":
      return { background: "#0B0B0B", mark: <DroidLogo size={inner} /> };
    case "raycast":
      return { background: "#FF6363", mark: <Command size={inner} weight="bold" color="#fff" /> };
    case "token":
      return { background: "var(--ade-mcp-generic-tile)", mark: <Key size={inner} weight="duotone" /> };
    case "other":
      return { background: "var(--ade-mcp-generic-tile)", mark: <PlugsConnected size={inner} weight="duotone" /> };
    default:
      return null;
  }
}

/** An app's logo as a rounded tile, the same shape for every app. */
export function McpAppLogo({ app, size = 32 }: { app: McpLogoId | null; size?: number }) {
  const id: McpLogoId = app ?? "other";
  const Lobe = id === "token" || id === "other" ? undefined : LOBE[id];
  const custom = Lobe ? null : customMark(id, size);
  return (
    <span
      className="ade-amcp-logo"
      data-generic={id === "token" || id === "other" ? "true" : undefined}
      style={{ width: size, height: size, background: custom?.background }}
      aria-hidden
    >
      {Lobe ? <Lobe size={size} shape="square" /> : custom?.mark}
      {/* Grok Bot is Grok, working in your team's chat. */}
      {id === "grok-bot" ? (
        <span className="ade-amcp-logo-badge" style={{ width: Math.round(size * 0.48), height: Math.round(size * 0.48) }}>
          <Robot size={Math.round(size * 0.32)} weight="fill" />
        </span>
      ) : null}
    </span>
  );
}

/** Names for every app ADE recognises at sign-in. */
export const KNOWN_APP_LABEL: Record<RemoteMcpKnownApp, string> = {
  claude: "Claude",
  "claude-code": "Claude Code",
  chatgpt: "ChatGPT",
  codex: "Codex",
  grok: "Grok",
  "grok-bot": "Grok Bot",
  cursor: "Cursor",
  vscode: "VS Code",
  "gemini-cli": "Gemini CLI",
  perplexity: "Perplexity",
  "le-chat": "Le Chat",
  windsurf: "Windsurf",
  zed: "Zed",
  goose: "Goose",
  opencode: "OpenCode",
  amp: "Amp",
  factory: "Factory",
  raycast: "Raycast",
};

// ── Setup steps ─────────────────────────────────────────────────────────

export type SetupSnippet = { code: string; copyLabel: string; caption?: string };

export type SetupStep = {
  title: ReactNode;
  detail?: ReactNode;
  snippet?: SetupSnippet;
  /** This step opens ADE's sign-in page: show what the person will see there. */
  signIn?: { pageTitle?: string };
};

/** The apps with their own setup steps, in the order the gallery shows them. */
export type GalleryAppId =
  | "claude"
  | "chatgpt"
  | "claude-code"
  | "codex"
  | "grok"
  | "grok-bot"
  | "cursor"
  | "vscode"
  | "gemini-cli"
  | "perplexity"
  | "other";

export type GalleryApp = {
  id: GalleryAppId;
  /** The name on the tile and in "Connect …". */
  label: string;
  /** Who makes it, and where it runs. */
  subtitle: string;
  /** It signs in with the person's ADE account. */
  signIn: boolean;
  /** It can send a token instead. */
  token: boolean;
  /** The token snippet the token dialog opens on, for an app that takes one. */
  tokenSnippet?: TokenSnippetId;
  /** The footer button that opens the token dialog, when it is not "Use a token instead". */
  tokenAction?: string;
  steps: (url: string) => SetupStep[];
  /** Short troubleshooting lines, for the gotchas this app has. */
  notes?: ReactNode[];
};

const json = (value: unknown) => JSON.stringify(value, null, 2);

export const GALLERY_APPS: readonly GalleryApp[] = [
  {
    id: "claude",
    label: "claude.ai",
    subtitle: "Anthropic · web, desktop and mobile",
    signIn: true,
    token: false,
    steps: (url) => [
      {
        title: "Open Connectors",
        detail: <>In claude.ai, go to <Path parts={["Customize", "Connectors"]} />, then <Path parts={["+ Add", "Add custom connector"]} />.</>,
      },
      {
        title: "Name it ADE and paste the server URL",
        snippet: { code: url, copyLabel: "Copy server URL" },
      },
      { title: "Choose Add, then Connect", signIn: {} },
      { title: "Use it anywhere", detail: "The connector follows your Claude account to the desktop and mobile apps." },
    ],
    notes: [
      <>On a Team or Enterprise plan, an owner adds it once in <Path parts={["Organization settings", "Connectors", "Add", "Custom", "Web"]} />. Then each person connects it.</>,
    ],
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    subtitle: "OpenAI · web and desktop",
    signIn: true,
    token: false,
    steps: (url) => [
      {
        title: "Open Apps in ChatGPT's settings",
        detail: <>Go to <Path parts={["Settings", "Apps"]} /> (Plugins on some plans) and choose <b>Add custom MCP server</b>. ChatGPT may ask you to turn on developer mode first.</>,
      },
      {
        title: "Name it ADE and paste the server URL",
        detail: "If it asks how to sign in, pick OAuth.",
        snippet: { code: url, copyLabel: "Copy server URL" },
      },
      { title: "Create it, then sign in", signIn: {} },
    ],
    notes: [
      "ChatGPT can't use tokens. Sign-in is the only way it connects.",
    ],
  },
  {
    id: "claude-code",
    label: "Claude Code",
    subtitle: "Anthropic · terminal",
    signIn: true,
    token: true,
    tokenSnippet: "claude-code",
    steps: (url) => [
      {
        title: "Add ADE in a terminal",
        snippet: { code: `claude mcp add --transport http ade ${url}`, copyLabel: "Copy Claude Code command" },
      },
      {
        title: "Sign in from Claude Code",
        detail: <>Run <code>/mcp</code>, pick <b>ade</b> and choose <b>Authenticate</b>. Your browser opens.</>,
        signIn: {},
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    subtitle: "OpenAI · terminal and IDE",
    signIn: true,
    token: true,
    tokenSnippet: "codex",
    steps: (url) => [
      {
        title: "Add ADE in a terminal",
        snippet: { code: `codex mcp add ade --url ${url}`, copyLabel: "Copy Codex command" },
      },
      {
        title: "Sign in",
        snippet: { code: "codex mcp login ade", copyLabel: "Copy Codex sign-in command" },
        signIn: {},
      },
    ],
  },
  {
    id: "grok",
    label: "Grok",
    subtitle: "xAI · grok.com",
    signIn: true,
    token: false,
    tokenSnippet: "xai",
    tokenAction: "Token for the xAI API",
    steps: (url) => [
      {
        title: "Open Connectors on grok.com",
        detail: <>Go to <b>grok.com/connectors</b>, then <Path parts={["New Connector", "Custom"]} />.</>,
      },
      {
        title: "Paste the server URL",
        snippet: { code: url, copyLabel: "Copy server URL" },
      },
      { title: "Save it, then sign in", signIn: {} },
    ],
    notes: [
      "Calling Grok through the xAI API instead? The API sends a token, not a sign-in. Make one with Use a token.",
    ],
  },
  {
    id: "grok-bot",
    label: "Grok Bot",
    subtitle: "xAI · Grok in your team's chat",
    signIn: true,
    token: false,
    steps: (url) => [
      {
        title: "Ask Grok Bot to add ADE",
        detail: <>Send it this message, or use <Path parts={["Plugins", "Add"]} />.</>,
        snippet: { code: `Add a custom MCP server: ${url}`, copyLabel: "Copy message for Grok Bot" },
      },
      { title: "Open the sign-in link it sends", signIn: { pageTitle: "Connect Grok Bot" } },
    ],
    notes: [
      "Grok Bot reaches ADE over the internet, so give it this exact address. A localhost or home-network address won't work.",
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    subtitle: "Anysphere · editor and cloud agents",
    signIn: true,
    token: true,
    tokenSnippet: "cursor",
    steps: (url) => [
      {
        title: "Add ADE to Cursor's MCP file",
        detail: <>Put this in <code>~/.cursor/mcp.json</code> (merge it with any servers already there).</>,
        snippet: { code: json({ mcpServers: { ade: { url } } }), copyLabel: "Copy Cursor config" },
      },
      {
        title: "Sign in",
        detail: <>Cursor shows ADE under <Path parts={["Cursor Settings", "MCP"]} />. Choose its sign-in button.</>,
        signIn: {},
      },
    ],
  },
  {
    id: "vscode",
    label: "VS Code",
    subtitle: "Microsoft · GitHub Copilot chat",
    signIn: true,
    token: true,
    tokenSnippet: "vscode",
    steps: (url) => [
      {
        title: "Add ADE",
        detail: <>Run this in a terminal, or use <Path parts={["Command Palette", "MCP: Add Server", "HTTP"]} /> and paste the server URL.</>,
        snippet: { code: `code --add-mcp '${JSON.stringify({ name: "ade", type: "http", url })}'`, copyLabel: "Copy VS Code command" },
      },
      { title: "Allow VS Code to sign in", signIn: {} },
    ],
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    subtitle: "Google · terminal",
    signIn: true,
    token: true,
    tokenSnippet: "gemini-cli",
    steps: (url) => [
      {
        title: "Add ADE to Gemini's settings",
        detail: <>Put this in <code>~/.gemini/settings.json</code> (merge it with what's there).</>,
        snippet: { code: json({ mcpServers: { ade: { httpUrl: url } } }), copyLabel: "Copy Gemini CLI settings" },
      },
      {
        title: "Sign in from Gemini CLI",
        snippet: { code: "/mcp auth ade", copyLabel: "Copy Gemini CLI sign-in command" },
        signIn: {},
      },
    ],
  },
  {
    id: "perplexity",
    label: "Perplexity",
    subtitle: "Perplexity · web and Mac",
    signIn: true,
    token: false,
    steps: (url) => [
      {
        title: "Open Connectors",
        detail: <>Go to <Path parts={["Settings", "Connectors"]} />, then <Path parts={["Add custom", "Remote"]} />.</>,
      },
      {
        title: "Paste the server URL",
        snippet: { code: url, copyLabel: "Copy server URL" },
      },
      { title: "Save it, then sign in", signIn: {} },
    ],
  },
  {
    id: "other",
    label: "Any other app",
    subtitle: "Any app that adds a remote MCP server",
    signIn: true,
    token: true,
    tokenSnippet: "curl",
    steps: (url) => [
      {
        title: "Find where the app adds an MCP server",
        detail: "It's often called a custom connector, a remote MCP server or an integration. If it asks for a type, pick Streamable HTTP (or just HTTP).",
      },
      {
        title: "Paste the server URL",
        snippet: { code: url, copyLabel: "Copy server URL" },
      },
      { title: "Sign in", signIn: {} },
    ],
    notes: [
      "If the app asks for a header or an API key instead of signing in, use a token.",
    ],
  },
];

export function galleryApp(id: GalleryAppId): GalleryApp {
  return GALLERY_APPS.find((app) => app.id === id) ?? GALLERY_APPS[GALLERY_APPS.length - 1]!;
}

/** The gallery tile an existing connection belongs to, so the tile can say "Connected". */
export function galleryIdForKnownApp(app: RemoteMcpKnownApp | null): GalleryAppId | null {
  if (!app) return null;
  return GALLERY_APPS.some((entry) => entry.id === app) ? (app as GalleryAppId) : null;
}

/** One line each for the other apps ADE recognises, for the "Any other app" view. */
export const OTHER_APP_HINTS: readonly { app: RemoteMcpKnownApp; how: (url: string) => { text: ReactNode; copy?: string } }[] = [
  { app: "le-chat", how: () => ({ text: <>Le Chat: <Path parts={["Connectors", "+ Add Connector", "Custom MCP Connector"]} /> (a workspace admin adds it).</> }) },
  { app: "windsurf", how: (url) => ({ text: <>Windsurf: in Cascade's MCP config, set <code>serverUrl</code>.</>, copy: json({ mcpServers: { ade: { serverUrl: url } } }) }) },
  { app: "zed", how: () => ({ text: <>Zed: <Path parts={["Settings", "AI", "MCP Servers", "Add Remote Server"]} />.</> }) },
  { app: "goose", how: () => ({ text: <>Goose: <Path parts={["Extensions", "Add custom extension", "Remote"]} />.</> }) },
  { app: "opencode", how: () => ({ text: <>OpenCode: add it as a remote server, then run <code>opencode mcp auth ade</code>.</>, copy: "opencode mcp auth ade" }) },
  { app: "amp", how: (url) => ({ text: <>Amp: <code>amp mcp add ade</code> with the URL.</>, copy: `amp mcp add ade ${url}` }) },
  { app: "factory", how: (url) => ({ text: <>Factory: <code>droid mcp add</code> with the URL.</>, copy: `droid mcp add ade ${url} --type http` }) },
  { app: "raycast", how: () => ({ text: <>Raycast: run its <b>Install MCP Server</b> command.</> }) },
];

/** A menu path: Settings › Apps. */
export function Path({ parts }: { parts: readonly string[] }) {
  return (
    <span className="ade-amcp-path">
      {parts.map((part, index) => (
        <span key={`${part}-${index}`}>
          {index > 0 ? <i aria-hidden>›</i> : null}
          <b>{part}</b>
        </span>
      ))}
    </span>
  );
}

// ── Token snippets ──────────────────────────────────────────────────────

export type TokenSnippetId = "xai" | "openai" | "claude-code" | "codex" | "cursor" | "vscode" | "gemini-cli" | "curl";

export type TokenSnippet = {
  id: TokenSnippetId;
  label: string;
  logo: McpLogoId;
  /** Where it goes. */
  where: ReactNode;
  build: (url: string, token: string) => string;
};

export const TOKEN_SNIPPETS: readonly TokenSnippet[] = [
  {
    id: "xai",
    label: "xAI API",
    logo: "grok",
    where: <>Add to <code>tools</code> in a Responses request.</>,
    build: (url, token) => json({ type: "mcp", server_label: "ade", server_url: url, authorization: `Bearer ${token}` }),
  },
  {
    id: "openai",
    label: "OpenAI API",
    logo: "chatgpt",
    where: <>Add to <code>tools</code> in a Responses request or the Agents SDK.</>,
    build: (url, token) => json({ type: "mcp", server_label: "ade", server_url: url, authorization: token }),
  },
  {
    id: "claude-code",
    label: "Claude Code",
    logo: "claude-code",
    where: "Run in a terminal.",
    build: (url, token) => `claude mcp add --transport http ade ${url} --header "Authorization: Bearer ${token}"`,
  },
  {
    id: "codex",
    label: "Codex",
    logo: "codex",
    where: <>Add to <code>~/.codex/config.toml</code>, and set the variable in your shell.</>,
    build: (url, token) => [
      "# ~/.codex/config.toml",
      "[mcp_servers.ade]",
      `url = "${url}"`,
      'bearer_token_env_var = "ADE_MCP_TOKEN"',
      "",
      "# your shell profile",
      `export ADE_MCP_TOKEN="${token}"`,
    ].join("\n"),
  },
  {
    id: "cursor",
    label: "Cursor",
    logo: "cursor",
    where: <>Put in <code>~/.cursor/mcp.json</code>.</>,
    build: (url, token) => json({ mcpServers: { ade: { url, headers: { Authorization: `Bearer ${token}` } } } }),
  },
  {
    id: "vscode",
    label: "VS Code",
    logo: "vscode",
    where: <>Put in <code>.vscode/mcp.json</code> or your user MCP file.</>,
    build: (url, token) => json({ servers: { ade: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }),
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    logo: "gemini-cli",
    where: <>Put in <code>~/.gemini/settings.json</code>.</>,
    build: (url, token) => json({ mcpServers: { ade: { httpUrl: url, headers: { Authorization: `Bearer ${token}` } } } }),
  },
  {
    id: "curl",
    label: "Any app or script",
    logo: "other",
    where: <>Send <code>Authorization: Bearer</code> with the token. To try it:</>,
    build: (url, token) => [
      `curl ${url} \\`,
      `  -H "Authorization: Bearer ${token}" \\`,
      '  -H "Content-Type: application/json" \\',
      '  -H "Accept: application/json, text/event-stream" \\',
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    ].join("\n"),
  },
];

export function tokenSnippet(id: TokenSnippetId): TokenSnippet {
  return TOKEN_SNIPPETS.find((snippet) => snippet.id === id) ?? TOKEN_SNIPPETS[0]!;
}
