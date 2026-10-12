import React, { useCallback, useMemo, useState } from "react";
import { ArrowsClockwise, PencilSimple, Plus, Trash, Warning } from "@phosphor-icons/react";
import { CALLER_MCP_SUPPORT } from "../../../../shared/callerMcpServers";
import {
  mcpRegistryState,
  type McpRegistryServer,
  type McpRegistryState,
  type McpSecretField,
} from "../../../../shared/mcpRegistry";
import type { McpConfigProvider, McpFoundServer } from "../../../../shared/types/mcpRegistry";
import { useAppStore } from "../../../state/appStore";
import { showToast } from "../../app/toast/toastStore";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { SettingsToggle } from "../primitives/SettingsControls";
import { ModernPage, ModernRow, ModernRows, ModernSection } from "../primitives/SettingsModern";
import { SettingsColumn } from "../primitives/SettingsRows";
import { McpSecretWarnings, mcpServerHoldsPlainSecret } from "./McpSecretWarnings";
import { McpServerDialog } from "./McpServerDialog";
import { missingMcpSecrets, useMcpRegistry, type McpRegistryApi, type McpRegistryLevel } from "./useMcpRegistry";
import "./mcpServers.css";

/**
 * Settings › MCP servers.
 *
 * Three views of one list:
 *
 * - **In your account** — every server in the registry, where it is on or off
 *   (your account, this computer, this project), and what this computer is
 *   missing to run it.
 * - **Found on this computer, not in ADE** — servers the provider CLIs have in
 *   their own settings here, each one click from being in the registry.
 * - **Who gets them** — which agents the registry reaches, read off the same
 *   table the launch path uses, so the page cannot promise more than a chat
 *   will get.
 */

const STATE_LABEL: Record<McpRegistryState, string> = {
  on: "On",
  "off-account": "Off everywhere",
  "off-machine": "Off on this computer",
  "off-project": "Off in this project",
};

const TRANSPORT_LABEL = { stdio: "Command", http: "HTTP", sse: "SSE" } as const;

const PROVIDER_NAME: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  pi: "Pi",
};

function providerName(id: string): string {
  return PROVIDER_NAME[id] ?? id;
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What a server runs or where it answers, as one line. */
function targetLine(server: Pick<McpRegistryServer, "transport" | "command" | "args" | "url">): string {
  if (server.transport !== "stdio") return server.url ?? "";
  return [server.command ?? "", ...(server.args ?? [])].join(" ");
}

export function McpServersSection() {
  const registry = useMcpRegistry();
  const projectName = useAppStore((state) => state.project?.displayName?.trim() || null);
  const [dialog, setDialog] = useState<{ editing: McpRegistryServer | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ready = registry.phase === "ready";

  /** Runs one change on one row, and says so when it did not take. */
  const run = useCallback(async (key: string, failed: string, change: () => Promise<string | null>): Promise<boolean> => {
    setBusy(key);
    const error = await change();
    setBusy(null);
    if (error) showToast({ tone: "error", title: failed, message: error });
    return error == null;
  }, []);

  const handleRemove = useCallback(async (server: McpRegistryServer) => {
    const confirmed = await confirmDialog({
      title: `Remove ${server.name}?`,
      message: "It is removed from your account, on every computer, with its saved values. Chats that are already running keep it.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    if (await run(server.name, `Could not remove ${server.name}`, () => registry.removeServer(server.name))) {
      showToast({ tone: "success", title: `Removed ${server.name}` });
    }
  }, [registry, run]);

  const handleImport = useCallback(async (server: McpFoundServer) => {
    if (await run(`found:${server.name}`, `Could not import ${server.name}`, () => registry.importFound(server.name))) {
      showToast(mcpServerHoldsPlainSecret(server)
        ? {
            tone: "warning",
            title: `Imported ${server.name}`,
            message: "Its arguments or URL look like they hold a secret. That part syncs as plain text. Edit it to move the secret.",
          }
        : { tone: "success", title: `Imported ${server.name}`, message: "New chats get it from now on." });
    }
  }, [registry, run]);

  return (
    <SettingsColumn wide>
      <ModernPage>
        {registry.phase === "unavailable" ? (
          <Banner
            layout="inline"
            model={{
              id: "mcp-registry-unavailable",
              tone: "warning",
              title: "MCP servers can't be changed right now",
              // Plain words, not the service's own error text: that names
              // internal parts ("Domain 'account_settings' ...") the reader
              // cannot act on.
              detail: "ADE's background service did not answer. This is the copy saved on this computer.",
              actions: [{ label: "Try again", onClick: () => void registry.reload() }],
            }}
          />
        ) : null}

        <ModernSection
          group="In your account"
          anchor="mcp-servers"
          title="In your account"
          hint="Every ADE agent gets these, on every computer you sign in on."
          actions={(
            <button
              type="button"
              className="ade-modern-btn"
              data-tone="primary"
              disabled={!ready}
              onClick={() => setDialog({ editing: null })}
              data-mcp-add=""
            >
              <Plus size={12} weight="bold" /> Add
            </button>
          )}
        >
          {registry.servers.length === 0 ? (
            <div className="ade-mcp-empty" data-mcp-empty="">
              {registry.phase === "loading"
                ? "Loading…"
                : ready
                  ? "No servers yet. Add one, or import one this computer already has."
                  : "Your servers will show here once ADE can read them."}
            </div>
          ) : (
            <div className="ade-modern-rows" data-mcp-server-list="">
              {registry.servers.map((server) => (
                <ServerRow
                  key={server.name}
                  server={server}
                  registry={registry}
                  projectName={projectName}
                  busy={busy === server.name}
                  readOnly={!ready}
                  onLevel={(level, on) => void run(server.name, `Could not change ${server.name}`, () => registry.setLevel(server.name, level, on))}
                  onSecret={(field, name, value) => run(server.name, `Could not save ${name}`, () => registry.setSecret(server.name, field, name, value))}
                  onEdit={() => setDialog({ editing: server })}
                  onRemove={() => void handleRemove(server)}
                />
              ))}
            </div>
          )}
        </ModernSection>

        <ModernSection
          group="Found on this computer"
          anchor="mcp-found"
          title="Found on this computer, not in ADE"
          hint="From your provider tools' own settings. Import one to give it to every agent."
          actions={(
            <button type="button" className="ade-modern-btn" disabled={registry.phase === "loading"} onClick={() => void registry.reload()}>
              <ArrowsClockwise size={12} weight="bold" /> Look again
            </button>
          )}
        >
          {registry.found.length === 0 ? (
            <div className="ade-mcp-empty" data-mcp-found-empty="">
              {registry.phase === "loading" ? "Loading…" : "Nothing here that ADE does not already have."}
            </div>
          ) : (
            <div className="ade-modern-rows" data-mcp-found-list="">
              {registry.found.map((server) => (
                <div key={server.name} className="ade-mcp-row" data-mcp-found={server.name}>
                  <div className="ade-mcp-head">
                    <span className="ade-mcp-name">{server.name}</span>
                    <span className="kit-tag">{TRANSPORT_LABEL[server.transport]}</span>
                    <span className="ade-mcp-head-end">
                      <FoundFrom providers={server.providers} />
                      <button
                        type="button"
                        className="ade-modern-btn"
                        disabled={busy != null || !ready}
                        aria-label={`Import ${server.name}`}
                        onClick={() => void handleImport(server)}
                      >
                        Import
                      </button>
                    </span>
                  </div>
                  <div className="ade-mcp-target" title={targetLine(server)}>{targetLine(server)}</div>
                  <McpSecretWarnings server={server} />
                </div>
              ))}
            </div>
          )}
          {registry.skipped.length > 0 ? (
            <p className="ade-modern-muted">
              Not offered, because ADE can't hold a server with this name or shape: {list(registry.skipped)}.
            </p>
          ) : null}
        </ModernSection>

        <WhoGetsThem />
      </ModernPage>

      {dialog ? (
        <McpServerDialog
          editing={dialog.editing}
          existingNames={registry.servers.map((server) => server.name)}
          heldSecretKeys={registry.check?.heldSecretKeys ?? null}
          onClose={() => setDialog(null)}
          onSave={async (server, secrets) => {
            const error = await registry.saveServer(server, secrets, dialog.editing ? "edit" : "create");
            if (error) return error;
            showToast({
              tone: "success",
              title: `${dialog.editing ? "Saved" : "Added"} ${server.name}`,
              message: "New chats get it from now on.",
            });
            setDialog(null);
            return null;
          }}
        />
      ) : null}
    </SettingsColumn>
  );
}

function FoundFrom({ providers }: { providers: readonly McpConfigProvider[] }) {
  return (
    <span className="ade-mcp-from" title={`In ${list(providers.map(providerName))}`}>
      {providers.map((provider) => <ProviderLogo key={provider} family={provider} size={14} />)}
      {list(providers.map(providerName))}
    </span>
  );
}

function ServerRow({
  server,
  registry,
  projectName,
  busy,
  readOnly,
  onLevel,
  onSecret,
  onEdit,
  onRemove,
}: {
  server: McpRegistryServer;
  registry: McpRegistryApi;
  projectName: string | null;
  busy: boolean;
  /** The list is this computer's saved copy and cannot be changed right now. */
  readOnly: boolean;
  onLevel: (level: McpRegistryLevel, on: boolean) => void;
  onSecret: (field: McpSecretField, name: string, value: string) => Promise<boolean>;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const state = mcpRegistryState(server, registry.off);
  const missingSecrets = registry.check ? missingMcpSecrets(server, registry.check.heldSecretKeys) : [];
  const commandMissing = registry.check?.missingCommands.has(server.name) === true;
  const hasComputer = registry.context.deviceOffKey != null;
  const hasProject = registry.context.repoScope != null;
  const target = targetLine(server);

  return (
    <div className="ade-mcp-row" data-mcp-server={server.name} data-state={state === "on" ? "on" : "off"}>
      <div className="ade-mcp-head">
        <span className="ade-mcp-name">{server.name}</span>
        <span className="kit-tag">{TRANSPORT_LABEL[server.transport]}</span>
        <span className="kit-tag" data-tone={state === "on" ? "ok" : undefined} data-mcp-state={state}>
          {STATE_LABEL[state]}
        </span>
        <span className="ade-mcp-head-end">
          <button type="button" className="ade-modern-btn" data-variant="ghost" data-icon="true" aria-label={`Edit ${server.name}`} title="Edit" disabled={readOnly} onClick={onEdit}>
            <PencilSimple size={13} weight="bold" />
          </button>
          <button type="button" className="ade-modern-btn" data-variant="ghost" data-icon="true" aria-label={`Remove ${server.name}`} title="Remove" disabled={readOnly} onClick={onRemove}>
            <Trash size={13} weight="bold" />
          </button>
        </span>
      </div>
      <div className="ade-mcp-target" title={target}>{target}</div>

      <div className="ade-mcp-levels">
        <LevelSwitch
          label="Your account"
          hint="Every computer you sign in on"
          checked={server.enabled}
          busy={busy}
          unavailable={readOnly}
          onChange={(on) => onLevel("account", on)}
        />
        <LevelSwitch
          label="This computer"
          hint={hasComputer ? "Only this computer" : "This computer has no sync identity yet"}
          checked={!registry.off.machine.includes(server.name)}
          busy={busy}
          unavailable={readOnly || !hasComputer}
          onChange={(on) => onLevel("machine", on)}
        />
        <LevelSwitch
          label={projectName ? `This project (${projectName})` : "This project"}
          hint={hasProject ? "This repository, on every computer" : "Needs an open project with a git remote"}
          checked={hasProject && !registry.off.project.includes(server.name)}
          busy={busy}
          unavailable={readOnly || !hasProject}
          onChange={(on) => onLevel("project", on)}
        />
      </div>

      {commandMissing ? (
        <div className="ade-modern-note" data-tone="warn" data-mcp-command-missing="">
          <Warning size={14} weight="fill" />
          <div className="ade-modern-note-body">
            <span><span className="ade-modern-code">{server.command}</span> was not found on this computer. Install it here, or switch this server off on this computer.</span>
          </div>
        </div>
      ) : null}
      {missingSecrets.map((secret) => (
        <MissingSecret
          key={`${secret.field}:${secret.name}`}
          name={secret.name}
          disabled={busy || readOnly}
          onSave={(value) => onSecret(secret.field, secret.name, value)}
        />
      ))}
    </div>
  );
}

function LevelSwitch({
  label,
  hint,
  checked,
  busy,
  unavailable,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  /** A change to this row is being saved: not pressable, but not dimmed, so the row does not flicker. */
  busy: boolean;
  /** This level cannot be changed here at all. Dimmed, label included. */
  unavailable: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <span className="ade-mcp-level" title={hint} data-disabled={unavailable ? "true" : undefined}>
      <SettingsToggle checked={checked} disabled={unavailable} onChange={(on) => { if (!busy) onChange(on); }} label={label} />
      {label}
    </span>
  );
}

/** One value this computer does not hold, with the box to give it one. */
function MissingSecret({
  name,
  disabled,
  onSave,
}: {
  name: string;
  disabled: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    if (!value || disabled) return;
    void onSave(value).then((saved) => {
      if (saved) setValue("");
    });
  };
  return (
    <div className="ade-modern-note" data-tone="warn" data-mcp-secret-missing={name}>
      <Warning size={14} weight="fill" />
      <div className="ade-modern-note-body">
        <span><span className="ade-modern-code">{name}</span> has no value on this computer. The server starts without it.</span>
        <div className="ade-mcp-secret">
          <input
            className="ade-modern-field"
            data-mono="true"
            type="password"
            autoComplete="off"
            aria-label={`Value of ${name}`}
            placeholder="Value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          <button type="button" className="ade-modern-btn" disabled={disabled || !value} onClick={submit}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which agents the registry reaches.
 *
 * The shipped providers are read off `CALLER_MCP_SUPPORT`, the table the launch
 * path itself consults, so a provider that gains or loses a transport changes
 * this page without an edit here. The last row is the part no table knows: the
 * agents ADE does not hand registry servers to yet.
 */
function WhoGetsThem() {
  const groups = useMemo(() => {
    const all: string[] = [];
    const partial: Array<{ id: string; transports: string[] }> = [];
    const none: string[] = [];
    for (const [id, support] of Object.entries(CALLER_MCP_SUPPORT)) {
      const blocked: readonly string[] = "unsupportedTransports" in support ? support.unsupportedTransports : [];
      if (support.level === "unsupported") none.push(id);
      else if (blocked.length) partial.push({ id, transports: blocked.map((transport) => transport.toUpperCase()) });
      else all.push(id);
    }
    return { all, partial, none };
  }, []);

  const logos = (ids: readonly string[]) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ display: "inline-flex", gap: 4 }}>
        {ids.map((id) => <ProviderLogo key={id} family={id} size={14} />)}
      </span>
      {list(ids.map(providerName))}
    </span>
  );

  return (
    <ModernSection group="In your account" title="Who gets them" hint="Chats started after a change. A chat that is already running keeps what it started with.">
      <ModernRows>
        {groups.all.length ? <ModernRow title={logos(groups.all)} hint="Every server that is on." /> : null}
        {groups.partial.map((entry) => (
          <ModernRow
            key={entry.id}
            title={logos([entry.id])}
            hint={`Every server that is on, except ${list(entry.transports)} ones. ${providerName(entry.id)} can't connect to those.`}
          />
        ))}
        {groups.none.map((id) => (
          <ModernRow key={id} title={logos([id])} hint={`None. ${providerName(id)} can't use MCP servers.`} />
        ))}
        <ModernRow
          title="Copilot, Grok, Kimi, Qwen, Devin, and personal chats"
          hint="Not yet."
        />
      </ModernRows>
    </ModernSection>
  );
}
