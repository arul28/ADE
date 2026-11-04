// TEMPORARY preview page for the owner review. Delete before commit.
import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { IntegrationConnectComposer } from "./components/chat/IntegrationConnectCard";
import { McpServerRequestComposer } from "./components/chat/McpServerCard";
import type { PendingInputRequest } from "../shared/types/chat";

const req = (id: string): PendingInputRequest => ({
  requestId: id, source: "ade", kind: "structured_question", questions: [], allowsFreeform: false, blocking: true, canProceedWithoutAnswer: false,
});
const noop = () => {};
const which = new URLSearchParams(location.search).get("card") ?? "all";
const show = (k: string) => which === "all" || which === k;

function App() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28, padding: 28, width: 860 }}>
      {show("github") && <IntegrationConnectComposer request={req("g")} chatProvider="claude" card={{ provider: "github", reason: "To open a PR for this fix and read the review comments" }} responding={false} error={null} onConnect={noop} onDecline={noop} />}
      {show("linear") && <IntegrationConnectComposer request={req("l")} chatProvider="codex" card={{ provider: "linear", reason: "To read ENG-431 and move it to In Review when the PR is up" }} responding={false} error={null} onConnect={noop} onDecline={noop} />}
      {show("jira") && <IntegrationConnectComposer request={req("j")} chatProvider="claude" card={{ provider: "jira", reason: "To read ticket ADE-1 you asked about" }} responding={false} error={null} onConnect={noop} onDecline={noop} />}
      {show("mcp") && <McpServerRequestComposer request={req("m")} chatProvider="claude" card={{ source: "agent", reason: "To search the Notion docs you mentioned", server: { name: "notion", transport: "http", url: "https://mcp.notion.com/mcp", envNames: [], headerNames: ["Authorization"], enabled: true } as any, runs: "https://mcp.notion.com/mcp", providers: [], secrets: [{ field: "header", name: "Authorization", questionId: "q1", copied: false }] }} responding={false} error={null} onAdd={noop} onDecline={noop} />}
      {show("mcp2") && <McpServerRequestComposer request={req("m2")} chatProvider="claude" card={{ source: "imported", reason: "To use the Sentry server you already have in Claude Code", server: { name: "sentry", transport: "stdio", command: "npx", args: ["-y", "@sentry/mcp-server"], envNames: ["SENTRY_AUTH_TOKEN"], headerNames: [], enabled: true } as any, runs: "npx -y @sentry/mcp-server", providers: ["claude"], secrets: [{ field: "env", name: "SENTRY_AUTH_TOKEN", questionId: "q2", copied: true }] }} responding={false} error={null} onAdd={noop} onDecline={noop} />}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
