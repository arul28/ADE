/**
 * Demo data for a provider page's "Initial context window" card in the browser
 * preview. The Claude numbers are from a real measurement of a new ADE chat.
 */
import type {
  GetProviderContextInventoryArgs,
  ProviderContextInventory,
  ProviderContextItem,
} from "../shared/types/providerContext";

const skill = (name: string, tokens: number): ProviderContextItem => ({
  id: `skill:${name}`,
  owner: "user",
  kind: "skill",
  label: name,
  tokens,
  sizeKind: "estimated",
  timing: "chat-start",
});

const ADE_ITEMS: ProviderContextItem[] = [
  { id: "ade:prompt", owner: "ade", kind: "system-prompt", label: "ADE harness prompt", source: "systemPrompt.append", tokens: 1110, sizeKind: "exact", timing: "every-request" },
  { id: "ade:cli", owner: "ade", kind: "instructions", label: "ADE command line guide", tokens: 1190, sizeKind: "exact", timing: "every-request" },
  {
    id: "ade:skills",
    owner: "ade",
    kind: "skills",
    label: "ADE skills",
    detail: "Names and descriptions; a skill's body loads when it is used.",
    tokens: 1400,
    sizeKind: "exact",
    timing: "every-request",
    children: ["ade-browser", "ade-app-control", "ade-apple", "ade-cli-control-plane", "ade-proof-artifacts"].map((name) => ({
      id: `ade-skill:${name}`, owner: "ade", kind: "skill", label: name, tokens: 280, sizeKind: "exact", timing: "chat-start",
    } satisfies ProviderContextItem)),
  },
  { id: "ade:cu", owner: "ade", kind: "tools", label: "Screen control rules", tokens: 980, sizeKind: "exact", timing: "chat-start" },
  { id: "ade:notes", owner: "ade", kind: "notes", label: "Project notes", setIn: "ADE Settings › Agent notes", settingsEntry: "project-agents.agent-notes", tokens: 640, sizeKind: "exact", timing: "chat-start" },
];

const CLAUDE_USER: ProviderContextItem[] = [
  { id: "claude:memory", owner: "user", kind: "memory", label: "Auto memory index", source: "~/.claude/projects/…/memory/MEMORY.md", detail: "The first 200 lines load at start.", tokens: 7300, sizeKind: "estimated", timing: "every-request" },
  {
    id: "claude:skills",
    owner: "user",
    kind: "skills",
    label: "Your skills",
    source: "~/.claude/skills",
    tokens: 11300,
    sizeKind: "estimated",
    timing: "every-request",
    children: [skill("asc-release-flow", 160), skill("clerk-setup", 120), skill("higgsfield-generate", 210), skill("hyperframes", 190)],
  },
  { id: "claude:mcp:rea", owner: "user", kind: "mcp-server", label: "MCP server: rea", setIn: "~/.claude.json", path: "/Users/ada/.claude.json", settingsEntry: "mcp.found", tokens: 2400, sizeKind: "estimated", timing: "every-request" },
  { id: "claude:mcp:ghost", owner: "user", kind: "mcp-server", label: "MCP server: ghost-os", setIn: "~/.claude.json", path: "/Users/ada/.claude.json", settingsEntry: "mcp.found", detail: "Its instructions are sent with every request.", tokens: 2800, sizeKind: "estimated", timing: "every-request" },
  { id: "claude:mcp:xcode", owner: "user", kind: "mcp-server", label: "MCP server: XcodeBuildMCP", setIn: "ADE Settings › MCP servers", settingsEntry: "mcp.servers", tokens: 1300, sizeKind: "estimated", timing: "every-request" },
  { id: "claude:agents", owner: "user", kind: "agent", label: "Agent types", source: "plugins", tokens: 1800, sizeKind: "estimated", timing: "every-request" },
  { id: "claude:global-md", owner: "user", kind: "instructions", label: "Your CLAUDE.md", source: "~/.claude/CLAUDE.md", path: "/Users/ada/.claude/CLAUDE.md", tokens: 900, sizeKind: "estimated", timing: "every-request" },
];

const CLAUDE_PROJECT: ProviderContextItem[] = [
  { id: "claude:project-md", owner: "project", kind: "instructions", label: "Project CLAUDE.md", source: "CLAUDE.md", path: "/Users/ada/Projects/ADE/CLAUDE.md", tokens: 4500, sizeKind: "estimated", timing: "every-request" },
];

export function browserMockProviderContextInventory(args: GetProviderContextInventoryArgs): ProviderContextInventory {
  const claude = args.provider === "claude";
  const basic = ["grok", "devin", "antigravity", "muse"].includes(args.provider);
  const items: ProviderContextItem[] = [
    {
      id: "harness",
      owner: "harness",
      kind: "system-prompt",
      label: "Built-in prompt and tools",
      detail: claude ? "The rest of the measured first turn." : null,
      tokens: claude ? 17600 : null,
      sizeKind: claude ? "measured" : "unknown",
      timing: "every-request",
    },
    ...ADE_ITEMS,
    ...(claude ? [...CLAUDE_USER, ...CLAUDE_PROJECT] : []),
    ...(!claude && !basic ? [
      { id: "agents-md", owner: "project", kind: "instructions", label: "Project AGENTS.md", source: "AGENTS.md", tokens: 5200, sizeKind: "estimated", timing: "every-request" } satisfies ProviderContextItem,
    ] : []),
  ];
  return {
    provider: args.provider,
    generatedAt: new Date().toISOString(),
    cwd: "~/Projects/ADE",
    laneId: null,
    coverage: basic ? "basic" : "good",
    coverageNote: basic
      ? "This provider does not document which of your files it reads, so only ADE's part is listed."
      : "ADE's part is exact; your files are estimated from their text.",
    items,
    measured: claude ? { firstTurnTokens: 58500, sampleCount: 123, since: new Date(Date.now() - 30 * 86_400_000).toISOString(), scope: "project" } : null,
  };
}
