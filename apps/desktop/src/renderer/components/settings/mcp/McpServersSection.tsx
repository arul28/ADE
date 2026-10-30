import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowClockwise, CheckCircle, Key, PencilSimple, Plus, Trash, Warning } from "@phosphor-icons/react";
import { REGISTRY_MCP_PROVIDER_IDS, registryMcpSupport } from "../../../../shared/callerMcpServers";
import { flashRowHighlight } from "../../../lib/flashRowHighlight";
import {
  MCP_TRANSPORT_LABEL,
  mcpRegistryState,
  type McpRegistryServer,
  type McpRegistryState,
  type McpSecretField,
} from "../../../../shared/mcpRegistry";
import type { McpConfigProvider, McpFoundServer, McpServerSignIn } from "../../../../shared/types/mcpRegistry";
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
import { isImeComposing } from "../../../lib/imeComposition";

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

const PROVIDER_NAME: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  pi: "Pi",
  kimi: "Kimi",
  copilot: "Copilot",
  muse: "Muse",
  qwen: "Qwen",
  grok: "Grok",
  devin: "Devin",
  antigravity: "Antigravity",
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
  const [searchParams] = useSearchParams();
  const focusServer = searchParams.get("mcpServer")?.trim() ?? "";
  const focusedServerRef = useRef<{ name: string; focused: boolean } | null>(null);
  const projectName = useAppStore((state) => state.project?.displayName?.trim() || null);
  const [dialog, setDialog] = useState<{ editing: McpRegistryServer | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A sign-in waits on the browser for minutes, so it is not `busy`: the rest
  // of the page stays usable while it runs.
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const ready = registry.phase === "ready";

  useEffect(() => {
    if (focusedServerRef.current?.name !== focusServer) {
      focusedServerRef.current = focusServer ? { name: focusServer, focused: false } : null;
    }
    const request = focusedServerRef.current;
    if (!focusServer || !ready) return;
    if (!request || request.focused) return;
    const row = document.querySelector<HTMLElement>(`[data-mcp-server="${CSS.escape(focusServer)}"]`);
    if (!row) return;
    request.focused = true;
    return flashRowHighlight(row);
  }, [focusServer, ready, registry.servers]);

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

  const handleSignIn = useCallback(async (server: McpRegistryServer) => {
    setSigningIn(server.name);
    const result = await registry.signIn(server);
    setSigningIn((current) => (current === server.name ? null : current));
    if (!result.ok) {
      if (!result.cancelled) showToast({ tone: "error", title: `Could not sign in to ${server.name}`, message: result.message });
      return;
    }
    showToast({ tone: "success", title: `Signed in to ${server.name}`, message: "New chats can use its tools, with every provider, on every computer." });
  }, [registry]);

  const handleCancelSignIn = useCallback((name: string) => registry.cancelSignIn(name), [registry]);

  const handleSignOut = useCallback(async (server: McpRegistryServer) => {
    if (await run(server.name, `Could not sign out of ${server.name}`, () => registry.signOut(server.name))) {
      showToast({ tone: "success", title: `Signed out of ${server.name}`, message: "New chats start it signed out. Revoke the key on the server's own site to end it there too." });
    }
  }, [registry, run]);

  const handleImport = useCallback(async (server: McpFoundServer) => {
    if (await run(`found:${server.name}`, `Could not import ${server.name}`, () => registry.importFound(server.name))) {
      showToast(mcpServerHoldsPlainSecret(server)
        ? {
            tone: "warning",
            title: `Imported ${server.name}`,
            message: "Its arguments or URL look like they hold a secret. That part syncs as plain text. Edit it to move the secret.",
            // A message to read, not a passing event (docs/design/notices.md, Toast timing).
            durationMs: 18_000,
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
                  signingIn={signingIn === server.name}
                  onSignIn={() => void handleSignIn(server)}
                  onCancelSignIn={() => handleCancelSignIn(server.name)}
                  onSignOut={() => void handleSignOut(server)}
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
            <button type="button" className="ade-modern-btn" data-variant="ghost" disabled={registry.phase === "loading"} onClick={() => void registry.reload()}>
              <ArrowClockwise size={13} /> Check again
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
                    <span className="kit-tag">{MCP_TRANSPORT_LABEL[server.transport]}</span>
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
  signingIn,
  onSignIn,
  onCancelSignIn,
  onSignOut,
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
  signingIn: boolean;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onSignOut: () => void;
}) {
  const state = mcpRegistryState(server, registry.off);
  const signIn = registry.check?.signIns.get(server.name) ?? null;
  const missingSecrets = registry.check ? missingMcpSecrets(server, registry.check.heldSecretKeys) : [];
  const commandMissing = registry.check?.missingCommands.has(server.name) === true;
  const hasComputer = registry.context.deviceOffKey != null;
  const hasProject = registry.context.repoScope != null;
  const target = targetLine(server);

  return (
    <div className="ade-mcp-row" data-mcp-server={server.name} data-state={state === "on" ? "on" : "off"}>
      <div className="ade-mcp-head">
        <span className="ade-mcp-name">{server.name}</span>
        <span className="kit-tag">{MCP_TRANSPORT_LABEL[server.transport]}</span>
        <span className="kit-tag" data-tone={state === "on" ? "ok" : undefined} data-mcp-state={state}>
          {STATE_LABEL[state]}
        </span>
        {signIn ? (
          <span className="kit-tag" data-tone={signIn.state === "valid" ? "ok" : "warn"} data-mcp-sign-in-state={signIn.state}>
            {signIn.state === "valid" ? "Signed in" : signIn.state === "expired" ? "Sign-in ran out" : "Needs sign-in"}
          </span>
        ) : null}
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

      {signIn || signingIn ? (
        <SignInNote
          name={server.name}
          signIn={signIn}
          signingIn={signingIn}
          disabled={busy || readOnly}
          onSignIn={onSignIn}
          onCancel={onCancelSignIn}
          onSignOut={onSignOut}
        />
      ) : null}
      {commandMissing ? (
        <div className="ade-modern-note" data-tone="warn" data-mcp-command-missing="">
          <Warning size={14} weight="fill" />
          <div className="ade-modern-note-body">
            <span><span className="ade-modern-code">{server.command}</span> was not found on this computer. Install it here, or switch this server off on this computer.</span>
          </div>
        </div>
      ) : null}
      <McpSecretWarnings server={server} compact />
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

function expiresLine(expiresAt: string | null): string {
  if (!expiresAt) return "Every ADE agent uses this sign-in, on every computer you use.";
  const ms = Date.parse(expiresAt) - Date.now();
  const days = Math.floor(ms / 86_400_000);
  const when = days >= 2 ? `in ${days} days` : ms > 3_600_000 ? `in ${Math.round(ms / 3_600_000)} hours` : "soon";
  return `Every ADE agent uses this sign-in, on every computer you use. It runs out ${when}.`;
}

/** A server's browser sign-in: the ask, the wait on the browser, or who is signed in. */
function SignInNote({
  name,
  signIn,
  signingIn,
  disabled,
  onSignIn,
  onCancel,
  onSignOut,
}: {
  name: string;
  signIn: McpServerSignIn | null;
  signingIn: boolean;
  disabled: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}) {
  if (signingIn) {
    return (
      <div className="ade-modern-note" data-mcp-sign-in="waiting">
        <Key size={14} weight="fill" />
        <div className="ade-modern-note-body">
          <span>Finish signing in to {name} in your browser. ADE is waiting for it.</span>
          <div className="ade-mcp-secret">
            <button type="button" className="ade-modern-btn" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }
  if (signIn?.state === "valid") {
    return (
      <div className="ade-modern-note" data-tone="ok" data-mcp-sign-in="valid">
        <CheckCircle size={14} weight="fill" />
        <div className="ade-modern-note-body">
          <span>{expiresLine(signIn.expiresAt)}</span>
          <div className="ade-mcp-secret">
            <button type="button" className="ade-modern-btn" disabled={disabled} onClick={onSignIn}>Sign in again</button>
            <button type="button" className="ade-modern-btn" data-variant="ghost" disabled={disabled} onClick={onSignOut}>Sign out</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="ade-modern-note" data-tone="warn" data-mcp-sign-in={signIn?.state ?? "needed"}>
      <Warning size={14} weight="fill" />
      <div className="ade-modern-note-body">
        <span>
          {signIn?.state === "expired"
            ? `Your sign-in to ${name} ran out. Agents can't use its tools until you sign in again.`
            : `${name} asks you to sign in before agents can use its tools. Sign in once here and every ADE agent gets it, on every computer.`}
        </span>
        <div className="ade-mcp-secret">
          <button type="button" className="ade-modern-btn" data-tone="primary" disabled={disabled} onClick={onSignIn}>
            Sign in
          </button>
        </div>
      </div>
    </div>
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
              if (isImeComposing(event)) return;
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
 * The agents ADE does not hand registry servers to yet. Written by hand: it
 * is the one row here that `REGISTRY_MCP_PROVIDER_IDS` does not drive, so it changes
 * only when someone edits it.
 */
const NOT_SERVED_YET = "Grok, Qwen, Devin, and personal chats";

/**
 * Which agents the registry reaches.
 *
 * The shipped providers are read off `registryMcpSupport`, which the launch
 * path itself consults, so a provider that gains or loses a transport changes
 * this page without an edit here. The last row is {@link NOT_SERVED_YET}, which
 * no table knows.
 */
function WhoGetsThem() {
  const groups = useMemo(() => {
    const all: string[] = [];
    const partial: Array<{ id: string; transports: string[] }> = [];
    const none: string[] = [];
    for (const id of REGISTRY_MCP_PROVIDER_IDS) {
      const support = registryMcpSupport(id);
      const blocked: readonly string[] = support?.unsupportedTransports ?? [];
      if (!support) none.push(id);
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
        <ModernRow title={NOT_SERVED_YET} hint="Not yet." />
      </ModernRows>
    </ModernSection>
  );
}
