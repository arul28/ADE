/**
 * Settings › Connections, before one is opened: what ADE and its agents are
 * connected to, then everything that can be added.
 *
 * - Connected: GitHub, Linear and Jira when they work, and every MCP server in
 *   the account. Each tile says where it is saved.
 * - Add a connection: ADE's own integrations, then the verified MCP servers of
 *   ADE's catalogue (`mcpCatalogue.ts`), then "Add your own".
 *
 * Integration statuses are read on the page's machine (`pin`), where their
 * credentials live. MCP servers belong to the account, so they are read
 * through this desktop's brain with no pin, as Settings › MCP servers does.
 */
import React, { useEffect, useMemo, useState } from "react";
import { CaretRight, DownloadSimple, MagnifyingGlass, Plugs, Plus, SealCheck } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import { captureError } from "../../../../shared/sentry/capture";
import { MCP_CATALOGUE, matchMcpCatalogue, type McpCatalogueEntry } from "../../../../shared/mcpCatalogue";
import type { McpRegistryServer } from "../../../../shared/mcpRegistry";
import { INTEGRATION_IDS, integrationBrand, integrationThemeVars, type IntegrationId } from "./integrationBrand";
import type { IntegrationTone } from "./IntegrationChrome";
import { SolidLogo } from "../providers/ProviderHero";
import { useMcpRegistry } from "../mcp/useMcpRegistry";
import { MCP_ACCENT, mcpCatalogueBrand } from "../mcp/mcpCatalogueBrand";
import { McpCatalogueAddDialog } from "../mcp/McpCatalogueAddDialog";
import "../providers/providerPage.css";
import "./integrationPage.css";

/** A page under Connections: one integration's, or the MCP servers'. */
export type ConnectionPageId = IntegrationId | "mcp";

type Summary = { tone: IntegrationTone; label: string };

const CHECKING: Summary = { tone: "checking", label: "Checking…" };
const UNKNOWN: Summary = { tone: "neutral", label: "Couldn't check" };

const DESCRIPTIONS: Record<IntegrationId, string> = {
  github: "Open, review and merge pull requests, follow checks, and work on issues.",
  linear: "Start lanes from Linear issues, link them to PRs, and let your team assign work to ADE.",
  jira: "Bring a Jira Cloud site's issues into ADE and tie them to this project.",
  agent37: "Make cloud Linux machines for your lanes, signed in to your account with no code to type.",
};

/** Where each integration's credential is saved. */
const SAVED_IN: Record<IntegrationId, string> = {
  github: "Your account",
  linear: "This project",
  jira: "This project",
  agent37: "Your account",
};

async function readSummary(id: IntegrationId, pin: OpenProjectBinding | null): Promise<Summary> {
  if (id === "agent37") {
    // Account-wide: the key is in the account vault, so this computer answers for every machine.
    const status = await window.ade.agent37?.getStatus();
    if (!status) return UNKNOWN;
    if (status.error) return { tone: "warn", label: status.connected ? "Couldn't reach Agent37" : "Needs attention" };
    if (status.connected) return { tone: "ok", label: status.balanceUsd != null ? `Connected · $${status.balanceUsd.toFixed(2)} left` : "Connected" };
    return { tone: "neutral", label: "Not connected" };
  }
  if (id === "github") {
    const status = await window.ade.github.getStatus(undefined, pin);
    if (status.connected) return { tone: "ok", label: status.userLogin ? `Connected as ${status.userLogin}` : "Connected" };
    if (status.authFailure || status.credentialStoreUnreadable) return { tone: "warn", label: "Needs attention" };
    return { tone: "neutral", label: "Not connected" };
  }
  if (id === "linear") {
    const cto = window.ade.cto;
    if (!cto) return UNKNOWN;
    const status = await cto.getLinearConnectionStatus(pin);
    if (status.connected) {
      const workspace = status.organizationName?.trim() || status.organizationUrlKey?.trim();
      return { tone: "ok", label: workspace ? `Connected to ${workspace}` : "Connected" };
    }
    return { tone: "neutral", label: "Not connected" };
  }
  const status = await window.ade.jira.getConnectionStatus(pin);
  if (status.error) return { tone: "warn", label: "Needs attention" };
  if (status.connected) {
    const site = status.siteUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return { tone: "ok", label: site ? `Connected to ${site}` : "Connected" };
  }
  return { tone: "neutral", label: "Not connected" };
}

function useIntegrationSummaries(pin: OpenProjectBinding | null): Record<IntegrationId, Summary> {
  const [summaries, setSummaries] = useState<Record<IntegrationId, Summary>>({
    github: CHECKING,
    linear: CHECKING,
    jira: CHECKING,
    agent37: CHECKING,
  });
  useEffect(() => {
    let cancelled = false;
    setSummaries({ github: CHECKING, linear: CHECKING, jira: CHECKING, agent37: CHECKING });
    for (const id of INTEGRATION_IDS) {
      readSummary(id, pin)
        .then((summary) => { if (!cancelled) setSummaries((prev) => ({ ...prev, [id]: summary })); })
        .catch((error: unknown) => {
          captureError(error, {
            tags: { feature: "integrations_settings", action: "read_status", integration: id },
            fingerprint: ["integrations_settings", "read_status", id],
            handled: true,
          });
          if (!cancelled) setSummaries((prev) => ({ ...prev, [id]: UNKNOWN }));
        });
    }
    return () => { cancelled = true; };
    // A rebuilt pin with the same key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.key]);
  return summaries;
}

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  if (!query) return true;
  return fields.some((field) => field?.toLowerCase().includes(query));
}

/** A small logo tile: an integration's or a catalogue server's 3D mark, or a plug. */
function ConnectionMark({ server, entry, integration }: {
  server?: McpRegistryServer;
  entry?: McpCatalogueEntry | null;
  integration?: IntegrationId;
}) {
  if (integration) {
    const brand = integrationBrand(integration);
    return (
      <span className="ade-cx-mark" style={brand.banner} data-light={brand.lightBanner ? "true" : undefined}>
        <SolidLogo spec={{ ...brand.logo, size: 22 }} straight />
      </span>
    );
  }
  if (entry) {
    const brand = mcpCatalogueBrand(entry);
    return (
      <span className="ade-cx-mark" style={brand.banner}>
        <SolidLogo spec={{ ...brand.logo, size: 22 }} straight />
      </span>
    );
  }
  return (
    <span className="ade-cx-mark ade-cx-mark-plain" title={server?.name}>
      <Plugs size={18} weight="duotone" />
    </span>
  );
}

export function ConnectionsHome({
  pin,
  onOpen,
}: {
  /** The page's machine: each integration status is read where its credential lives. */
  pin: OpenProjectBinding | null;
  /** Opens a page; `server` focuses one MCP server on it. */
  onOpen: (page: ConnectionPageId, server?: string) => void;
}) {
  const summaries = useIntegrationSummaries(pin);
  const registry = useMcpRegistry();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<McpCatalogueEntry | null>(null);
  const needle = query.trim().toLowerCase();

  const connectedIntegrations = INTEGRATION_IDS.filter((id) => summaries[id].tone === "ok");
  const servers = registry.servers;
  // A catalogue entry is "added" when a server has its name or is the same server.
  const addedEntryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const server of servers) {
      ids.add(server.name);
      const entry = matchMcpCatalogue(server);
      if (entry) ids.add(entry.id);
    }
    return ids;
  }, [servers]);
  const catalogue = MCP_CATALOGUE.filter((entry) =>
    !entry.native
    && !addedEntryIds.has(entry.id)
    && matches(needle, entry.name, entry.description, entry.publisher, entry.category));
  const builtIn = INTEGRATION_IDS.filter((id) => matches(needle, integrationBrand(id).label, DESCRIPTIONS[id]));
  const canAdd = registry.phase === "ready";

  return (
    <div className="ade-ig-home ade-cx-home">
      {connectedIntegrations.length || servers.length ? (
        <section className="ade-cx-section" aria-label="Connected">
          <h3 className="ade-cx-heading">Connected</h3>
          <div className="ade-cx-chips">
            {connectedIntegrations.map((id) => (
              <button
                key={id}
                type="button"
                className="ade-cx-chip"
                style={integrationThemeVars(integrationBrand(id).accent)}
                data-testid={`connection-connected-${id}`}
                onClick={() => onOpen(id)}
              >
                <ConnectionMark integration={id} />
                <span className="ade-cx-chip-text">
                  <span className="ade-cx-chip-name"><i className="ade-ig-dot" data-tone="ok" />{integrationBrand(id).label}</span>
                  <span className="ade-cx-chip-meta">{SAVED_IN[id]}</span>
                </span>
              </button>
            ))}
            {servers.map((server) => {
              const entry = matchMcpCatalogue(server);
              return (
                <button
                  key={server.name}
                  type="button"
                  className="ade-cx-chip"
                  style={integrationThemeVars(entry ? mcpCatalogueBrand(entry).accent : MCP_ACCENT)}
                  data-testid={`connection-connected-mcp-${server.name}`}
                  onClick={() => onOpen("mcp", server.name)}
                >
                  <ConnectionMark server={server} entry={entry} />
                  <span className="ade-cx-chip-text">
                    <span className="ade-cx-chip-name">
                      <i className="ade-ig-dot" data-tone={server.enabled ? "ok" : undefined} />
                      {entry?.name ?? server.name}
                    </span>
                    <span className="ade-cx-chip-meta">MCP · your account</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="ade-cx-section" aria-label="Add a connection">
        <div className="ade-cx-heading-row">
          <h3 className="ade-cx-heading">Add a connection</h3>
          <label className="ade-cx-search">
            <MagnifyingGlass size={13} />
            <input
              type="search"
              value={query}
              placeholder="Search"
              aria-label="Search connections"
              data-testid="connections-search"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {builtIn.length ? (
          <>
            <h4 className="ade-cx-subheading">Built into ADE</h4>
            <div className="ade-ig-grid">
              {builtIn.map((id) => {
                const brand = integrationBrand(id);
                const summary = summaries[id];
                return (
                  <button
                    key={id}
                    type="button"
                    className="ade-ig-tile"
                    style={integrationThemeVars(brand.accent)}
                    data-testid={`integration-tile-${id}`}
                    onClick={() => onOpen(id)}
                  >
                    <span className="ade-ig-tile-banner" style={brand.banner} aria-hidden>
                      <img src={brand.art} alt="" draggable={false} />
                      <SolidLogo spec={brand.logo} straight />
                    </span>
                    <span className="ade-ig-tile-body">
                      <span className="ade-ig-tile-name">
                        {brand.label}
                        <CaretRight size={13} weight="bold" />
                      </span>
                      <span className="ade-ig-tile-desc">{DESCRIPTIONS[id]}</span>
                      <span className="ade-ig-tile-status">
                        <i className="ade-ig-dot" data-tone={summary.tone} />
                        <span>{summary.label}</span>
                        <span className="ade-cx-saved">{SAVED_IN[id]}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        <h4 className="ade-cx-subheading">
          MCP servers
          <span className="ade-cx-subheading-note"><SealCheck size={11} weight="fill" /> Verified by ADE · saved to your account</span>
        </h4>
        <div className="ade-cx-grid">
          {catalogue.map((entry) => {
            const brand = mcpCatalogueBrand(entry);
            return (
              <button
                key={entry.id}
                type="button"
                className="ade-cx-tile"
                style={integrationThemeVars(brand.accent)}
                disabled={!canAdd}
                data-testid={`connection-catalogue-${entry.id}`}
                onClick={() => setAdding(entry)}
              >
                <ConnectionMark entry={entry} />
                <span className="ade-cx-tile-text">
                  <span className="ade-cx-tile-name">{entry.name}</span>
                  <span className="ade-cx-tile-desc">{entry.description}</span>
                </span>
                <Plus size={13} weight="bold" className="ade-cx-tile-add" />
              </button>
            );
          })}
          {matches(needle, "add your own mcp server custom") ? (
            <button
              type="button"
              className="ade-cx-tile ade-cx-tile-own"
              style={integrationThemeVars(MCP_ACCENT)}
              data-testid="connection-add-own"
              onClick={() => onOpen("mcp")}
            >
              <span className="ade-cx-mark ade-cx-mark-plain"><Plus size={18} weight="bold" /></span>
              <span className="ade-cx-tile-text">
                <span className="ade-cx-tile-name">Add your own</span>
                <span className="ade-cx-tile-desc">Any MCP server, by command or URL.</span>
              </span>
            </button>
          ) : null}
          {registry.found.length && matches(needle, "import found this computer") ? (
            <button
              type="button"
              className="ade-cx-tile ade-cx-tile-own"
              style={integrationThemeVars(MCP_ACCENT)}
              data-testid="connection-import"
              onClick={() => onOpen("mcp")}
            >
              <span className="ade-cx-mark ade-cx-mark-plain"><DownloadSimple size={18} weight="bold" /></span>
              <span className="ade-cx-tile-text">
                <span className="ade-cx-tile-name">Import {registry.found.length}</span>
                <span className="ade-cx-tile-desc">Servers your other tools have on this computer.</span>
              </span>
            </button>
          ) : null}
        </div>
        {!builtIn.length && !catalogue.length && needle ? (
          <p className="ade-cx-empty">Nothing matches "{query.trim()}". Add it as your own MCP server.</p>
        ) : null}
      </section>

      {adding ? (
        <McpCatalogueAddDialog
          entry={adding}
          registry={registry}
          onClose={() => setAdding(null)}
          onAdded={() => setAdding(null)}
        />
      ) : null}
    </div>
  );
}
