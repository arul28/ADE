/**
 * Settings › Integrations, before one is opened: what ADE and its agents are
 * connected to, then everything that can be added.
 *
 * - Connected: GitHub, Linear and Jira when they work, and every MCP server in
 *   the account.
 * - Add: ADE's own integrations, then MCP servers. Any MCP server can be
 *   added by command or URL; the catalogue (`mcpCatalogue.ts`) is only quick
 *   setups for popular ones, so the page never reads as the full list.
 *
 * Integration statuses are read on the page's machine (`pin`), where their
 * credentials live. MCP servers belong to the account, so they are read
 * through this desktop's brain with no pin, as Settings › Integrations › MCP servers does.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CaretRight, DownloadSimple, MagnifyingGlass, Plugs, Plus } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import { captureError } from "../../../../shared/sentry/capture";
import { connectProviderSpec } from "../../../../shared/integrationConnect";
import { MCP_CATALOGUE, matchMcpCatalogue, mcpCatalogueEntry, type McpCatalogueEntry } from "../../../../shared/mcpCatalogue";
import { mcpCatalogueAnchor, mcpCatalogueIdFromAnchor, settingsEntryById } from "../settingsManifest";
import { decodeSettingsHash } from "../settingsHash";
import type { McpRegistryServer } from "../../../../shared/mcpRegistry";
import { INTEGRATION_IDS, integrationBrand, integrationThemeVars, type IntegrationId } from "./integrationBrand";
import type { IntegrationTone } from "./IntegrationChrome";
import { SolidLogo } from "../providers/ProviderHero";
import { useMcpRegistry } from "../mcp/useMcpRegistry";
import { useAdeCloudEnabled } from "../../../state/cloudAccess";
import { MCP_ACCENT, mcpCatalogueBrand } from "../mcp/mcpCatalogueBrand";
import { McpCatalogueAddDialog } from "../mcp/McpCatalogueAddDialog";
import { McpServerDialog } from "../mcp/McpServerDialog";
import { showToast } from "../../app/toast/toastStore";
import "../providers/providerPage.css";
import "./integrationPage.css";

/** A page under Integrations: GitHub, Linear or Jira, or the MCP servers. */
export type IntegrationsPageId = IntegrationId | "mcp";

type Summary = {
  tone: IntegrationTone;
  label: string;
  /** Where the credential in use lives, when the status says; else where a new one is saved. */
  savedIn?: string;
};

const CHECKING: Summary = { tone: "checking", label: "Checking…" };
const UNKNOWN: Summary = { tone: "neutral", label: "Couldn't check" };
const OFFLINE: Summary = { tone: "neutral", label: "Machine offline" };

const DESCRIPTIONS: Record<IntegrationId, string> = {
  github: "Open, review and merge pull requests, follow checks, and work on issues.",
  linear: "Start lanes from Linear issues, link them to PRs, and let your team assign work to ADE.",
  jira: "Bring a Jira Cloud site's issues into ADE and tie them to this project.",
  cloud: "Make cloud Linux machines for your lanes, signed in to your account with no code to type.",
};

/** Where the credential lives: what the status says, else where a new one is saved. */
function savedIn(id: IntegrationId, summary?: Summary): string {
  return summary?.savedIn ?? (id === "cloud" || connectProviderSpec(id).savedScope === "account" ? "Your account" : "This project");
}

async function readSummary(id: IntegrationId, pin: OpenProjectBinding | null): Promise<Summary> {
  if (id === "cloud") {
    // Account-wide: access is the account's, so this computer answers for every machine.
    const status = await window.ade.cloud?.getStatus();
    if (!status) return UNKNOWN;
    if (status.signedOut) return { tone: "neutral", label: "Sign in to ADE" };
    if (status.error) return { tone: "warn", label: status.connected ? "Couldn't reach ADE Cloud" : "Not available" };
    if (status.connected) return { tone: "ok", label: "Ready", savedIn: "Your account" };
    return { tone: "neutral", label: "Not available yet" };
  }
  if (id === "github") {
    const status = await window.ade.github.getStatus(undefined, pin);
    if (status.connected) {
      return {
        tone: "ok",
        label: status.userLogin ? `Connected as ${status.userLogin}` : "Connected",
        // Only a pasted token follows the account; gh, an env token and the app sign-in are this computer's.
        savedIn: status.authSource === "pat" ? "Your account" : "This computer",
      };
    }
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

function useIntegrationSummaries(
  pin: OpenProjectBinding | null,
  online: boolean,
  ids: readonly IntegrationId[],
): Record<IntegrationId, Summary> {
  const [summaries, setSummaries] = useState<Record<IntegrationId, Summary>>({
    github: CHECKING,
    linear: CHECKING,
    jira: CHECKING,
    cloud: CHECKING,
  });
  useEffect(() => {
    let cancelled = false;
    if (!online) {
      setSummaries({ github: OFFLINE, linear: OFFLINE, jira: OFFLINE, cloud: OFFLINE });
      return undefined;
    }
    setSummaries({ github: CHECKING, linear: CHECKING, jira: CHECKING, cloud: CHECKING });
    for (const id of ids) {
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
  }, [pin?.key, online, ids.join(",")]);
  return summaries;
}

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  if (!query) return true;
  return fields.some((field) => field?.toLowerCase().includes(query));
}

/** A small logo tile: an integration's or a catalogue server's 3D mark, or a plug. */
function IntegrationMark({ server, entry, integration }: {
  server?: McpRegistryServer;
  entry?: McpCatalogueEntry | null;
  integration?: IntegrationId;
}) {
  if (integration) {
    const brand = integrationBrand(integration);
    return (
      <span className="ade-ix-mark" style={brand.banner} data-light={brand.lightBanner ? "true" : undefined}>
        <SolidLogo spec={{ ...brand.logo, size: 22 }} straight />
      </span>
    );
  }
  if (entry) {
    const brand = mcpCatalogueBrand(entry);
    return (
      <span className="ade-ix-mark" style={brand.banner}>
        <SolidLogo spec={{ ...brand.logo, size: 22 }} straight />
      </span>
    );
  }
  return (
    <span className="ade-ix-mark ade-ix-mark-plain" title={server?.name}>
      <Plugs size={18} weight="duotone" />
    </span>
  );
}

export function IntegrationsHome({
  pin,
  machineOnline = true,
  integrations: integrationsProp = INTEGRATION_IDS,
  onOpen,
}: {
  /** The page's machine: each integration status is read where its credential lives. */
  pin: OpenProjectBinding | null;
  /** False while that machine is offline: its integrations wait, the account's MCP servers do not. */
  machineOnline?: boolean;
  /** The built-in integrations to show; with no project, only the account-wide ones. */
  integrations?: readonly IntegrationId[];
  /** Opens a page; `server` focuses one MCP server on it. */
  onOpen: (page: IntegrationsPageId, server?: string) => void;
}) {
  const cloudEnabled = useAdeCloudEnabled();
  const integrations = useMemo(
    () => integrationsProp.filter((id) => id !== "cloud" || cloudEnabled),
    [cloudEnabled, integrationsProp],
  );
  const summaries = useIntegrationSummaries(pin, machineOnline, integrations);
  const registry = useMcpRegistry();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<McpCatalogueEntry | null>(null);
  const [addingOwn, setAddingOwn] = useState(false);
  const needle = query.trim().toLowerCase();

  const connectedIntegrations = integrations.filter((id) => summaries[id].tone === "ok");
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
  const builtIn = integrations.filter((id) => matches(needle, integrationBrand(id).label, DESCRIPTIONS[id]));
  const canAdd = registry.phase === "ready";

  // `#add-mcp-<id>` (a settings search result, a chat card's gear) opens that
  // server's add dialog, or its row once it is added. The link is used once.
  const location = useLocation();
  const navigate = useNavigate();
  const linkedEntry = mcpCatalogueEntry(mcpCatalogueIdFromAnchor(decodeSettingsHash(location.hash)));
  // The entry a link opened the dialog for: the first read is this computer's
  // copy, and the account sync after it can bring the same server from
  // another computer. Then its row, not a second add, is the answer.
  const [linkedDialog, setLinkedDialog] = useState<string | null>(null);
  const addedAs = (entryId: string) => servers.find((server) => server.name === entryId || matchMcpCatalogue(server)?.id === entryId);
  useEffect(() => {
    if (!linkedDialog || adding?.id !== linkedDialog) return;
    const added = addedAs(linkedDialog);
    if (!added) return;
    setLinkedDialog(null);
    setAdding(null);
    onOpen("mcp", added.name);
    // Re-checked as the list changes; the rest is read fresh each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers, linkedDialog]);
  useEffect(() => {
    if (!linkedEntry || linkedEntry.native || !canAdd) return;
    const added = addedAs(linkedEntry.id);
    if (added) {
      onOpen("mcp", added.name);
      return;
    }
    // Drop the link, and any page the URL had open before it: the hash alone
    // kept the home grid up, so a stale `integration=` would replace it.
    const params = new URLSearchParams(location.search);
    params.delete("integration");
    params.delete("mcpServer");
    navigate({ pathname: location.pathname, search: `?${params.toString()}`, hash: "" }, { replace: true });
    setAdding(linkedEntry);
    setLinkedDialog(linkedEntry.id);
    // Runs when the link arrives or the registry first loads, not on every server change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedEntry?.id, canAdd]);

  return (
    <div className="ade-ig-home ade-ix-home">
      {connectedIntegrations.length || servers.length ? (
        // Settings search hides the groups (`data-settings-group`) with no
        // matching tile. A server already added has no tile in the grid, so
        // its chip here carries the entry's anchor instead.
        <section className="ade-ix-section" aria-label="Connected" data-settings-group="connected">
          <h3 className="ade-ix-heading">Connected</h3>
          <div className="ade-ix-chips">
            {connectedIntegrations.map((id) => (
              <button
                key={id}
                type="button"
                className="ade-ix-chip"
                style={integrationThemeVars(integrationBrand(id).accent)}
                data-testid={`integrations-connected-${id}`}
                onClick={() => onOpen(id)}
              >
                <IntegrationMark integration={id} />
                <span className="ade-ix-chip-text">
                  <span className="ade-ix-chip-name"><i className="ade-ig-dot" data-tone="ok" />{integrationBrand(id).label}</span>
                  <span className="ade-ix-chip-meta">{savedIn(id, summaries[id])}</span>
                </span>
              </button>
            ))}
            {servers.map((server) => {
              const entry = matchMcpCatalogue(server);
              return (
                <button
                  key={server.name}
                  type="button"
                  className="ade-ix-chip"
                  style={integrationThemeVars(entry ? mcpCatalogueBrand(entry).accent : MCP_ACCENT)}
                  data-testid={`integrations-connected-mcp-${server.name}`}
                  data-settings-anchor={entry && !entry.native ? mcpCatalogueAnchor(entry.id) : undefined}
                  onClick={() => onOpen("mcp", server.name)}
                >
                  <IntegrationMark server={server} entry={entry} />
                  <span className="ade-ix-chip-text">
                    <span className="ade-ix-chip-name">
                      <i className="ade-ig-dot" data-tone={server.enabled ? "ok" : undefined} />
                      {entry?.name ?? server.name}
                    </span>
                    <span className="ade-ix-chip-meta">MCP · your account</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="ade-ix-section" aria-label="Add">
        <div className="ade-ix-heading-row">
          <h3 className="ade-ix-heading">Add</h3>
          <label className="ade-ix-search">
            <MagnifyingGlass size={13} />
            <input
              type="search"
              value={query}
              placeholder="Search"
              aria-label="Search integrations"
              data-testid="integrations-search"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {builtIn.length ? (
          <div className="ade-ix-group" data-settings-group="built-in">
            <h4 className="ade-ix-subheading">Built into ADE</h4>
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
                    data-settings-anchor={settingsEntryById(id === "cloud" ? "integrations.ade-cloud" : `integrations.${id}`)?.anchor}
                    disabled={!machineOnline}
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
                        <span className="ade-ix-saved">{savedIn(id, summary)}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="ade-ix-group" data-settings-group="mcp-servers">
          <div className="ade-ix-mcp-head">
            <h4 className="ade-ix-subheading">MCP servers</h4>
            <span className="ade-ix-mcp-actions">
              {registry.found.length ? (
                <button
                  type="button"
                  className="ade-ix-btn"
                  data-testid="integrations-import"
                  onClick={() => onOpen("mcp")}
                >
                  <DownloadSimple size={13} weight="bold" />
                  Import {registry.found.length} from your other tools
                </button>
              ) : null}
              <button
                type="button"
                className="ade-ix-btn"
                data-variant="primary"
                disabled={!canAdd}
                data-testid="integrations-add-own"
                onClick={() => setAddingOwn(true)}
              >
                <Plus size={13} weight="bold" />
                Add any MCP server
              </button>
            </span>
          </div>
          <p className="ade-ix-mcp-lead">Any MCP server works, by command or URL. Below are quick setups for popular ones.</p>
          <div className="ade-ix-grid">
            {catalogue.map((entry) => {
              const brand = mcpCatalogueBrand(entry);
              return (
                <button
                  key={entry.id}
                  id={mcpCatalogueAnchor(entry.id)}
                  data-settings-anchor={mcpCatalogueAnchor(entry.id)}
                  type="button"
                  className="ade-ix-tile"
                  style={integrationThemeVars(brand.accent)}
                  disabled={!canAdd}
                  data-testid={`integrations-catalogue-${entry.id}`}
                  onClick={() => setAdding(entry)}
                >
                  <IntegrationMark entry={entry} />
                  <span className="ade-ix-tile-text">
                    <span className="ade-ix-tile-name">{entry.name}</span>
                    <span className="ade-ix-tile-desc">{entry.description}</span>
                  </span>
                  <Plus size={13} weight="bold" className="ade-ix-tile-add" />
                </button>
              );
            })}
            <button
              type="button"
              className="ade-ix-tile ade-ix-tile-own"
              style={integrationThemeVars(MCP_ACCENT)}
              disabled={!canAdd}
              data-testid="integrations-add-own-tile"
              onClick={() => setAddingOwn(true)}
            >
              <span className="ade-ix-mark ade-ix-mark-plain"><Plus size={18} weight="bold" /></span>
              <span className="ade-ix-tile-text">
                <span className="ade-ix-tile-name">{needle ? `Add "${query.trim()}"` : "Not listed?"}</span>
                <span className="ade-ix-tile-desc">Add any MCP server by its command or URL.</span>
              </span>
            </button>
          </div>
        </div>
      </section>

      {addingOwn ? (
        <McpServerDialog
          editing={null}
          existingNames={servers.map((server) => server.name)}
          heldSecretKeys={registry.check?.heldSecretKeys ?? null}
          onClose={() => setAddingOwn(false)}
          onSave={async (server, secrets) => {
            const error = await registry.saveServer(server, secrets, "create");
            if (error) return error;
            showToast({ tone: "success", title: `Added ${server.name}`, message: "New chats get it from now on." });
            setAddingOwn(false);
            return null;
          }}
        />
      ) : null}

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
