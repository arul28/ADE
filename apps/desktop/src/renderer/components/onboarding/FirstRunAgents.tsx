import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CircleNotch, SignIn } from "@phosphor-icons/react";
import type { AiProviderConnectionStatus, AiSettingsStatus } from "../../../shared/types";
import { EXTERNAL_SESSION_PROVIDER_LABELS } from "../../../shared/types";
import { ProviderLogo } from "../shared/ProviderLogos";
import { useAccountSignInSheet } from "../settings/providers/accounts/AddProviderAccountSheet";
import { useDefaultProviderInstance } from "../settings/providers/accounts/useProviderInstances";
import { prefetchOnboardingDiscovery } from "./FirstRunFlow";
import "./firstRun.css";

/**
 * First-run step 3, "Connect your agents": which coding agents can run on this
 * computer right now, with a way to sign in to the ones that cannot.
 *
 * It reads the same status Settings › Agents & Models reads (`ai.getStatus`,
 * which answers before any project is open) and signs in through the same
 * flows: Claude Code and Codex through the account sheet (a machine-level
 * login, no project or terminal needed), Cursor through its browser login.
 * Every other provider shows up here only when it is already connected; the
 * rest are set up in Settings, which this card says.
 *
 * The status is re-read when the card opens, after a sign-in finishes, and
 * when the window regains focus (back from a browser login). No polling.
 */

type AgentId = "claude" | "codex" | "cursor";
type AgentState = "checking" | "connected" | "sign-in";

type AgentRow = {
  id: AgentId;
  label: string;
  state: AgentState;
  /** Under the name: the account when connected, how to sign in otherwise. */
  detail: string;
};

/** The three ADE signs in to from here, in the order the welcome card lists them. */
const PRIMARY_AGENTS: ReadonlyArray<{ id: AgentId; label: string; signInLine: string }> = [
  { id: "claude", label: "Claude Code", signInLine: "Sign in with your Claude account" },
  { id: "codex", label: "Codex", signInLine: "Sign in with ChatGPT" },
  { id: "cursor", label: "Cursor", signInLine: "Sign in with your Cursor account" },
];

/** Other providers worth a chip when they are already connected. */
const OTHER_AGENTS = ["droid", "pi", "muse", "copilot", "qwen", "kimi", "grok", "devin", "antigravity"] as const;
type OtherAgentId = (typeof OTHER_AGENTS)[number];

const OTHER_LABELS: Record<OtherAgentId, string> = {
  droid: EXTERNAL_SESSION_PROVIDER_LABELS.droid,
  pi: EXTERNAL_SESSION_PROVIDER_LABELS.pi,
  muse: EXTERNAL_SESSION_PROVIDER_LABELS.muse,
  copilot: EXTERNAL_SESSION_PROVIDER_LABELS.copilot,
  qwen: EXTERNAL_SESSION_PROVIDER_LABELS.qwen,
  kimi: EXTERNAL_SESSION_PROVIDER_LABELS.kimi,
  grok: EXTERNAL_SESSION_PROVIDER_LABELS.grok,
  devin: "Devin",
  antigravity: "Antigravity",
};

function accountLine(connection: AiProviderConnectionStatus | null | undefined): string | null {
  const parts = [connection?.accountPlan, connection?.accountEmail].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.length ? parts.join(" · ") : null;
}

/** Same rules as the Settings tiles: Claude by its SDK auth, the rest by their connection row. */
function agentRows(status: AiSettingsStatus | null, failed: boolean): AgentRow[] {
  return PRIMARY_AGENTS.map(({ id, label, signInLine }) => {
    // A failed read still offers sign-in; only a read in flight is "Checking".
    if (!status) return failed ? { id, label, state: "sign-in", detail: signInLine } : { id, label, state: "checking", detail: "Checking…" };
    const connection = status.providerConnections?.[id] ?? null;
    const connected = id === "claude"
      ? Boolean(status.availableProviders?.claude?.binary.present && status.availableProviders.claude.auth.ready)
      : connection?.runtimeAvailable === true || status.availableProviders?.[id] === true;
    if (connected) return { id, label, state: "connected", detail: accountLine(connection) ?? "Ready on this computer" };
    return { id, label, state: "sign-in", detail: signInLine };
  });
}

function connectedOthers(status: AiSettingsStatus | null): OtherAgentId[] {
  if (!status) return [];
  const available = status.availableProviders as Partial<Record<OtherAgentId, unknown>> | undefined;
  return OTHER_AGENTS.filter((id) => status.providerConnections?.[id]?.runtimeAvailable === true || available?.[id] === true);
}

export function FirstRunAgents({
  onDone,
}: {
  /** Continue (or Skip): setup goes on to projects either way. */
  onDone: () => void;
}) {
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
  const [machineName, setMachineName] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const loadingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const next = await window.ade.ai.getStatus({ force: true });
      setStatus(next);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  // Start finding projects now, so the next card opens with its list; it also names this computer.
  useEffect(() => {
    let cancelled = false;
    void prefetchOnboardingDiscovery()
      ?.then((result) => {
        if (!cancelled) setMachineName(result.machineName);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const rows = agentRows(status, failed);
  const others = connectedOthers(status);
  const connectedCount = rows.filter((row) => row.state === "connected").length + others.length;
  const checking = status == null && !failed;

  return (
    <div className="ade-glass-card ade-fr-projects ade-fr-agents" data-testid="first-run-agents">
      <header className="ade-fr-head">
        <span className="ade-fr-eyebrow">{machineName ? `Set up ${machineName}` : "Set up this computer"}</span>
        <h1 className="ade-fr-title">Connect your agents</h1>
        <p className="ade-fr-sub">
          ADE runs the coding agents you already use, on your own accounts. Connect one to start chatting; you can add
          more any time.
        </p>
      </header>

      <section className="ade-fr-list" aria-label="Coding agents on this computer">
        <div className="ade-fr-rows" role="list">
          {rows.map((row, index) => (
            <AgentRowView key={row.id} row={row} index={index} onChanged={refresh} />
          ))}
        </div>
        {others.length ? (
          <div className="ade-fr-agents-others">
            <span>Also ready</span>
            {others.map((id) => (
              <span key={id} className="ade-fr-agents-chip">
                <ProviderLogo family={id} size={12} />
                {OTHER_LABELS[id]}
              </span>
            ))}
          </div>
        ) : null}
        <p className="ade-fr-agents-more">
          {others.length
            ? "Add or manage agents any time in Settings › Agents & Models."
            : "OpenCode, Droid, Pi, Copilot and more are in Settings › Agents & Models."}
        </p>
      </section>

      <footer className="ade-fr-foot">
        <button type="button" className="ade-glass-link" onClick={onDone}>
          Skip
        </button>
        <span className="ade-fr-summary" aria-live="polite">
          {checking
            ? null
            : connectedCount
              ? `${connectedCount} connected`
              : "Connect one to start a chat"}
        </span>
        <button type="button" className="ade-glass-primary ade-fr-cta" onClick={onDone} disabled={checking}>
          {checking ? <CircleNotch size={15} weight="bold" className="animate-spin" /> : null}
          Continue
          {checking ? null : <ArrowRight size={16} weight="bold" className="ade-glass-primary-arrow" />}
        </button>
      </footer>
    </div>
  );
}

function AgentRowView({ row, index, onChanged }: { row: AgentRow; index: number; onChanged: () => void }) {
  return (
    <div
      className="ade-fr-row ade-fr-agent-row"
      role="listitem"
      data-state={row.state}
      style={{ animationDelay: `${index * 45}ms` }}
    >
      <span className="ade-fr-agent-main">
        <span className="ade-fr-icon ade-fr-agent-logo" aria-hidden="true">
          <ProviderLogo family={row.id} size={18} />
        </span>
        <span className="ade-fr-name">
          <span className="ade-fr-name-main">{row.label}</span>
          <span className="ade-fr-agent-detail">{row.detail}</span>
        </span>
      </span>
      {row.state === "connected" ? (
        <span className="ade-fr-agent-ok">
          <span className="ade-fr-agent-dot" aria-hidden="true" />
          Connected
        </span>
      ) : row.state === "checking" ? (
        <CircleNotch size={14} weight="bold" className="animate-spin ade-fr-agent-spin" aria-label="Checking" />
      ) : row.id === "cursor" ? (
        <CursorSignInButton onChanged={onChanged} />
      ) : (
        <AccountSignInButton provider={row.id} label={row.label} onChanged={onChanged} />
      )}
    </div>
  );
}

/** Claude Code and Codex: the account sheet Settings uses, on this computer. */
function AccountSignInButton({
  provider,
  label,
  onChanged,
}: {
  provider: "claude" | "codex";
  label: string;
  onChanged: () => void;
}) {
  const { instance, reload } = useDefaultProviderInstance(provider);
  const sheet = useAccountSignInSheet({
    provider,
    providerLabel: label,
    onChanged: () => {
      void reload();
      onChanged();
    },
  });
  return (
    <>
      <button
        type="button"
        className="ade-fr-agent-btn"
        aria-label={`Sign in to ${label}`}
        onClick={() => sheet.open({ existing: instance })}
      >
        <SignIn size={13} weight="bold" aria-hidden="true" />
        Sign in
      </button>
      {sheet.element}
    </>
  );
}

/** Cursor: its own browser login; the card re-reads status when the window comes back. */
function CursorSignInButton({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const signIn = useCallback(async () => {
    setBusy(true);
    try {
      await window.ade.ai.cursorAuthLogin();
    } catch {
      // The card stays on "Sign in"; Settings shows the full error.
    } finally {
      setBusy(false);
      onChanged();
    }
  }, [onChanged]);
  return (
    <button
      type="button"
      className="ade-fr-agent-btn"
      aria-label="Sign in to Cursor"
      disabled={busy}
      onClick={() => void signIn()}
    >
      {busy ? (
        <CircleNotch size={13} weight="bold" className="animate-spin" aria-hidden="true" />
      ) : (
        <SignIn size={13} weight="bold" aria-hidden="true" />
      )}
      {busy ? "Waiting…" : "Sign in"}
    </button>
  );
}
