// TEMPORARY preview page for the owner review. Delete before commit.
import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { IntegrationConnectComposer } from "./components/chat/IntegrationConnectCard";
import { McpServerRequestComposer } from "./components/chat/McpServerCard";
import { ConnectionsHome } from "./components/settings/integrations/ConnectionsHome";
import { mcpCatalogueEntry, mcpCatalogueServer } from "../shared/mcpCatalogue";
import { mcpServerRunsLine } from "../shared/mcpServerRequest";
import type { PendingInputRequest } from "../shared/types/chat";

const ok = (value: unknown) => Promise.resolve({ ok: true, value });
(window as any).ade = {
  app: { openExternal: async () => {} },
  github: { getStatus: async () => ({ connected: true, userLogin: "arul" }) },
  cto: { getLinearConnectionStatus: async () => ({ connected: true, organizationName: "ADE" }) },
  jira: { getConnectionStatus: async () => ({ connected: false }) },
  accountSettings: {
    get: ({ key }: { key: string }) => ok(key === "mcp.servers" ? [
      mcpCatalogueServer(mcpCatalogueEntry("sentry")!),
      { name: "my-tools", transport: "stdio", command: "node", args: ["tools.js"], envNames: [], headerNames: [], enabled: true },
    ] : []),
    sync: async () => ({ ok: false }),
  },
  mcpRegistry: {
    context: async () => ({ deviceOffKey: null, repoScope: null, cached: null }),
    scan: async () => ({ servers: [{ name: "figma", transport: "http", url: "http://127.0.0.1:3845/mcp", providers: ["claude"], env: {}, headers: {} }], skipped: [] }),
    check: async () => ({ ok: true, value: { heldSecretKeys: [], missingCommands: [], signIns: [] } }),
  },
};

const req = (id: string): PendingInputRequest => ({
  requestId: id, source: "ade", kind: "structured_question", questions: [], allowsFreeform: false, blocking: true, canProceedWithoutAnswer: false,
});
const noop = () => {};
const which = new URLSearchParams(location.search).get("card") ?? "all";
const show = (k: string) => which === "all" || which === k;
function catalogCard(id: string, reason: string) {
  const server = mcpCatalogueServer(mcpCatalogueEntry(id)!);
  return { source: "catalog" as const, catalogueId: id, reason, server, runs: mcpServerRunsLine(server), providers: [],
    secrets: [...server.envNames.map((name) => ({ field: "env" as const, name, questionId: `e-${name}`, copied: false })), ...server.headerNames.map((name) => ({ field: "header" as const, name, questionId: `h-${name}`, copied: false }))] };
}

function App() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28, padding: 28, width: which === "settings" ? 900 : 760 }}>
      {show("github") && <IntegrationConnectComposer request={req("g")} chatProvider="claude" card={{ provider: "github", reason: "To open a PR for this fix and read the review comments" }} responding={false} error={null} onConnect={noop} onDecline={noop} />}
      {show("github2") && <IntegrationConnectComposer request={req("g2")} chatProvider="claude" card={{ provider: "github", reason: "To open a PR for this fix", methods: ["token"], current: "arul · reads only" }} responding={false} error={null} onConnect={noop} onDecline={noop} />}
      {show("linear") && <IntegrationConnectComposer request={req("l")} chatProvider="codex" card={{ provider: "linear", reason: "To read ENG-431 and move it to In Review when the PR is up" }} responding={false} error={null} onConnect={noop} onDecline={noop} />}
      {show("jira") && <IntegrationConnectComposer request={req("j")} chatProvider="claude" card={{ provider: "jira", reason: "To read ticket ADE-1 you asked about" }} responding={false} error={null} onConnect={noop} onDecline={noop} />}
      {show("mcp") && <McpServerRequestComposer request={req("m")} chatProvider="claude" card={catalogCard("notion", "To search the Notion docs you mentioned")} responding={false} error={null} onAdd={noop} onDecline={noop} />}
      {show("mcp-brave") && <McpServerRequestComposer request={req("mb")} chatProvider="codex" card={catalogCard("brave-search", "To search the web for the error message")} responding={false} error={null} onAdd={noop} onDecline={noop} />}
      {show("mcp2") && <McpServerRequestComposer request={req("m2")} chatProvider="claude" card={{ source: "imported", reason: "To use the Sentry server you already have in Claude Code", server: { name: "sentry-local", transport: "stdio", command: "npx", args: ["-y", "@sentry/mcp-server"], envNames: ["SENTRY_AUTH_TOKEN"], headerNames: [], enabled: true }, runs: "npx -y @sentry/mcp-server", providers: ["claude"], secrets: [{ field: "env", name: "SENTRY_AUTH_TOKEN", questionId: "q2", copied: true }] }} responding={false} error={null} onAdd={noop} onDecline={noop} />}
      {show("mcp3") && <McpServerRequestComposer request={req("m3")} chatProvider="claude" card={{ source: "agent", reason: "To query our internal metrics", server: { name: "acme-metrics", transport: "http", url: "https://mcp.acme.dev/mcp", envNames: [], headerNames: ["X-Api-Key"], enabled: true }, runs: "https://mcp.acme.dev/mcp", providers: [], secrets: [{ field: "header", name: "X-Api-Key", questionId: "q3", copied: false }] }} responding={false} error={null} onAdd={noop} onDecline={noop} />}
      {which === "settings" && <ConnectionsHome pin={null} onOpen={noop} />}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
