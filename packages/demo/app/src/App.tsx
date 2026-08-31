/**
 * DataDesk — a small invoicing dashboard that happens to have an agent in it.
 *
 * This is the reference for what a third-party dev actually assembles:
 *
 *   - `<ProviderCards>` in the left sidebar, under the account block. The
 *     package does not place them; putting them somewhere other than above the
 *     composer is exactly the freedom it is claiming to offer.
 *   - `<AdeChat>` on the right, which brings the model picker in the composer
 *     rail with it. The picker switches the OPEN thread — the bridge forwards
 *     `setModel` to the SDK — and the package disables it while a turn streams,
 *     so DataDesk never asks the SDK to end a reply in progress.
 *   - Tool names never reach the user: `labels` renames `demodata.get_invoices`
 *     to "Searching your invoices…" and everything else under `demodata.*` to a
 *     generic line.
 *   - One `createTheme()` call supplies the brand colours; no CSS is overridden.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AdeChat,
  ProviderCards,
  adaptSdkClient,
  createTheme,
  type AdeChatClient,
  type ActivityLabelConfig,
} from "@ade-dev/chat-ui";

import { createBridgeClient, type AppConfig } from "./bridgeClient";

const bridge = createBridgeClient(
  `ws://${window.location.hostname}:${Number(import.meta.env.VITE_BRIDGE_PORT ?? 4318)}`,
);

/**
 * The customer-facing names for our own tools.
 *
 * Claude namespaces an MCP tool as `mcp__<server>__<tool>`, so both spellings
 * are mapped: the wildcard catches the namespaced form and anything we add to
 * the server later without touching this file.
 */
const labels: ActivityLabelConfig = {
  map: {
    "demodata.get_invoices": {
      running: "Searching your invoices…",
      done: "Searched invoices",
      error: "Couldn't search invoices",
    },
    "mcp__demodata__get_invoices": {
      running: "Searching your invoices…",
      done: "Searched invoices",
      error: "Couldn't search invoices",
    },
    "demodata.get_activity": {
      running: "Reading recent activity…",
      done: "Read recent activity",
      error: "Couldn't read activity",
    },
    "mcp__demodata__get_activity": {
      running: "Reading recent activity…",
      done: "Read recent activity",
      error: "Couldn't read activity",
    },
    "demodata.*": "Working with your data…",
    "mcp__demodata__*": "Working with your data…",
  },
  thinkingLabel: "Thinking about your books…",
};

const theme = createTheme({ accent: "#6d5efc", background: "#101014" });

/** Static rows so the dashboard looks like a product rather than a chat box. */
const INVOICE_ROWS = [
  { id: "INV-0007", customer: "Northwind Trading", amount: "$12,400.00", status: "Overdue" },
  { id: "INV-0012", customer: "Blue Harbour Labs", amount: "$3,150.50", status: "Paid" },
  { id: "INV-0019", customer: "Cedar & Co", amount: "$890.00", status: "Draft" },
];

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [connected, setConnected] = useState(bridge.connected);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => bridge.onConnectionChange(setConnected), []);
  useEffect(() => {
    bridge
      .config()
      .then(setConfig)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  // The adapter is what turns the SDK's client surface — here reached over a
  // WebSocket — into the shape `@ade-dev/chat-ui` renders. `defaults` carries the
  // create-time arguments the chat components have no vocabulary for: which
  // provider, which MCP servers, which permission preset.
  const client = useMemo<AdeChatClient | null>(() => {
    if (!config) return null;
    return adaptSdkClient(bridge, {
      defaults: config.defaults,
      providerFilter: ["claude", "codex", "cursor", "opencode", "droid"],
      commandHints: {
        claude: { loginCommand: "claude setup-token", installCommand: "npm i -g @anthropic-ai/claude-code" },
        codex: { loginCommand: "codex login", installCommand: "npm i -g @openai/codex" },
        opencode: { loginCommand: "opencode auth login", installCommand: "npm i -g opencode-ai" },
      },
    });
  }, [config]);

  return (
    <div className="datadesk">
      <aside className="datadesk-sidebar">
        <div className="datadesk-brand">
          <span className="datadesk-mark" aria-hidden="true" />
          <div>
            <strong>DataDesk</strong>
            <p>Acme Supply Co.</p>
          </div>
        </div>

        <nav className="datadesk-nav" aria-label="Sections">
          <a className="is-active" href="#invoices">Invoices</a>
          <a href="#activity">Activity</a>
          <a href="#settings">Settings</a>
        </nav>

        <section className="datadesk-panel">
          <h2>Agent access</h2>
          {client ? (
            // Placement is the host's call — these cards sit in the sidebar,
            // not stacked above the composer.
            <ProviderCards client={client} onlyNeedsAttention={false} />
          ) : (
            <p className="datadesk-muted">Connecting to the DataDesk host…</p>
          )}
        </section>

        <p className={`datadesk-status ${connected ? "is-online" : "is-offline"}`}>
          {connected ? "Host connected" : "Host offline"}
        </p>
      </aside>

      <main className="datadesk-main">
        <header className="datadesk-header">
          <div>
            <h1>Invoices</h1>
            <p className="datadesk-muted">3 open · 1 overdue</p>
          </div>
        </header>

        <table className="datadesk-table" id="invoices">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Customer</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {INVOICE_ROWS.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td>{row.customer}</td>
                <td>{row.amount}</td>
                <td>
                  <span className={`datadesk-pill is-${row.status.toLowerCase()}`}>{row.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="datadesk-chat" aria-label="Ask DataDesk">
          <h2>Ask DataDesk</h2>
          {error ? <p className="datadesk-error">{error}</p> : null}
          {client && config ? (
            <AdeChat
              client={client}
              threadKey={config.threadKey}
              {...(config.defaultModelId ? { defaultModelId: config.defaultModelId } : {})}
              labels={labels}
              theme={theme}
              placeholder="Ask about invoices, payments or activity…"
              emptyState={
                <div className="datadesk-empty">
                  <p>Ask anything about your books.</p>
                  <p className="datadesk-muted">
                    Try “Which invoices changed this week?” — DataDesk reads them with your own tools.
                  </p>
                </div>
              }
            />
          ) : (
            <p className="datadesk-muted">Starting the assistant…</p>
          )}
        </section>
      </main>
    </div>
  );
}
