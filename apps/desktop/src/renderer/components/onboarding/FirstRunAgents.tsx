import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CircleNotch, GearSix, SignIn } from "@phosphor-icons/react";
import type { AiSettingsStatus } from "../../../shared/types";
import { ProviderLogo } from "../shared/ProviderLogos";
import { useAccountSignInSheet } from "../settings/providers/accounts/AddProviderAccountSheet";
import { useDefaultProviderInstance } from "../settings/providers/accounts/useProviderInstances";
import type { SettingsProviderId } from "../settings/providers/types";
import { prefetchOnboardingDiscovery } from "./FirstRunFlow";
import {
  firstRunAgents,
  firstRunAgentStatus,
  type FirstRunAgent,
  type FirstRunAgentStatus,
} from "./firstRunAgentModel";
import "./firstRun.css";

/**
 * First-run step 3, "Connect your agents": every coding agent ADE runs, with
 * its real status on this computer and a way to sign in where setup can.
 *
 * It reads the same status Settings › Agents & Models reads (`ai.getStatus`,
 * which answers before any project is open) and signs in through the same
 * flows: Claude Code and Codex through the account sheet (a machine-level
 * login, no project or terminal needed), Cursor through its browser login.
 * The rest sign in with a terminal login or a key, and a terminal needs an
 * open project, so the card lists them under "Set up in Settings" instead of
 * offering a button that cannot work yet.
 *
 * Tiles with a status worth acting on (connected, or signable here) sit in
 * the top grid; the rest sit below in a compact one. The status is re-read
 * when the card opens, after a sign-in finishes, and when the window regains
 * focus (back from a browser login). No polling.
 */

type AgentTile = { agent: FirstRunAgent; status: FirstRunAgentStatus };

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
  // The top grid's order, fixed at the first answer, so a sign-in changes a
  // tile in place instead of reshuffling the grid under the pointer.
  const [order, setOrder] = useState<SettingsProviderId[] | null>(null);

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

  const agents = useMemo(() => firstRunAgents(), []);
  const tiles = useMemo<AgentTile[]>(
    () => agents.map((agent) => ({ agent, status: firstRunAgentStatus(agent, status, failed) })),
    [agents, failed, status],
  );

  const settled = status != null || failed;
  useEffect(() => {
    if (!settled || order) return;
    // Connected first, then the ones setup can sign in to, each in the list's own order.
    const rank = (tile: AgentTile) => (tile.status.state === "connected" ? 0 : 1);
    setOrder([...tiles].sort((a, b) => rank(a) - rank(b)).map((tile) => tile.agent.id));
  }, [order, settled, tiles]);

  const { primary, later } = useMemo(() => {
    const position = (id: SettingsProviderId) => {
      const index = order?.indexOf(id) ?? -1;
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    // While the first read is in flight, the agents only Settings can sign in
    // wait below already, so most tiles do not jump when it lands.
    const below = (tile: AgentTile) =>
      tile.status.state === "later" || (tile.status.state === "checking" && tile.agent.signIn === "settings");
    const top = tiles
      .filter((tile) => !below(tile))
      .sort((a, b) => position(a.agent.id) - position(b.agent.id));
    return { primary: top, later: tiles.filter(below) };
  }, [order, tiles]);

  const connectedCount = tiles.filter((tile) => tile.status.state === "connected").length;
  const checking = !settled;

  return (
    <div className="ade-glass-card ade-fr-projects ade-fr-agents" data-testid="first-run-agents">
      <header className="ade-fr-head">
        <span className="ade-fr-eyebrow">{machineName ? `Set up ${machineName}` : "Set up this computer"}</span>
        <h1 className="ade-fr-title">Connect your agents</h1>
        <p className="ade-fr-sub">
          ADE runs the coding agents you already use, on your own accounts. Connect one to start chatting; you can
          add more any time.
        </p>
      </header>

      <section className="ade-fr-list" aria-label="Coding agents on this computer">
        <div className="ade-fr-list-head">
          <span>{checking ? "Checking this computer…" : `${agents.length} agents ADE can run`}</span>
          {checking ? null : (
            <span className="ade-fr-agents-count">
              <span
                className="ade-fr-agent-dot"
                data-state={connectedCount ? "connected" : "idle"}
                aria-hidden="true"
              />
              {connectedCount} connected
            </span>
          )}
        </div>

        <div className="ade-fr-agents-scroll">
          <div className="ade-fr-agents-grid" role="list" aria-label="Agents">
            {primary.map((tile, index) => (
              <AgentTileView key={tile.agent.id} tile={tile} index={index} onChanged={refresh} />
            ))}
          </div>

          {later.length ? (
            <div className="ade-fr-agents-later">
              <div className="ade-fr-agents-later-head">
                <GearSix size={12} weight="bold" aria-hidden="true" />
                <span>
                  Set up in <b>Settings › Agents &amp; Models</b> once ADE opens. These sign in through their own
                  login.
                </span>
              </div>
              <div className="ade-fr-agents-later-grid" role="list" aria-label="Agents to set up in Settings">
                {later.map((tile, index) => (
                  <span
                    key={tile.agent.id}
                    className="ade-fr-later-tile"
                    data-logo={tile.agent.logo}
                    role="listitem"
                    title={`${tile.agent.label}: ${tile.status.detail}`}
                    style={{ animationDelay: `${120 + Math.min(index, 10) * 25}ms` }}
                  >
                    <ProviderLogo family={tile.agent.logo} size={15} />
                    <span className="ade-fr-later-name">{tile.agent.label}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <footer className="ade-fr-foot">
        <button type="button" className="ade-glass-link" onClick={onDone}>
          Skip
        </button>
        <span className="ade-fr-summary" aria-live="polite">
          {checking ? null : connectedCount ? null : "Connect one to start a chat"}
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

function AgentTileView({ tile, index, onChanged }: { tile: AgentTile; index: number; onChanged: () => void }) {
  const { agent, status } = tile;
  return (
    <div
      className="ade-fr-agent-tile"
      role="listitem"
      data-state={status.state}
      style={{ animationDelay: `${Math.min(index, 10) * 35}ms` }}
    >
      <span className="ade-fr-agent-logo" data-logo={agent.logo} aria-hidden="true">
        <ProviderLogo family={agent.logo} size={18} />
      </span>
      <span className="ade-fr-agent-text">
        <span className="ade-fr-agent-name">{agent.label}</span>
        <span className="ade-fr-agent-detail" title={status.detail}>
          {status.state === "connected" ? (
            <>
              <span className="ade-fr-agent-dot" data-state="connected" aria-hidden="true" />
              <span className="ade-fr-agent-detail-text">{status.detail}</span>
            </>
          ) : (
            <span className="ade-fr-agent-detail-text">{status.detail}</span>
          )}
        </span>
      </span>
      {status.state === "checking" ? (
        <CircleNotch size={14} weight="bold" className="animate-spin ade-fr-agent-spin" aria-label="Checking" />
      ) : status.state !== "sign-in" ? null : agent.signIn === "cursor" ? (
        <CursorSignInButton onChanged={onChanged} />
      ) : agent.id === "claude" || agent.id === "codex" ? (
        <AccountSignInButton provider={agent.id} label={agent.label} onChanged={onChanged} />
      ) : null}
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
      // The tile stays on "Sign in"; Settings shows the full error.
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
