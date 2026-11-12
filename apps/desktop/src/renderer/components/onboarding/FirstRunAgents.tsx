import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CircleNotch } from "@phosphor-icons/react";
import type { AiSettingsStatus } from "../../../shared/types";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { useAppStore } from "../../state/appStore";
import { settingsMachineScope, SettingsMachineScopeProvider } from "../settings/SettingsMachineScope";
import type { SettingsProviderId } from "../settings/providers/types";
import { FirstRunAgentRail } from "./FirstRunAgentRail";
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
 * flows, none of which needs a project or a terminal: Claude Code and Codex
 * through the account sheet, Cursor through its browser login, Antigravity
 * through the agent's own Google sign-in, and Grok, Devin, Muse, Copilot,
 * Droid and Kimi through the agent CLI sheet (their own login, run by ADE in a
 * private PTY). OpenCode, Qwen and Pi sign in with keys or their in-app
 * provider sign-ins, so the rail hangs them under "In Settings, later".
 *
 * The agents worth acting on (connected, or signable here) hang big on the
 * left of the rail (`FirstRunAgentRail`); the rest hang small on the right.
 * The status is re-read when the card opens, after a sign-in finishes, and
 * when the window regains focus (back from a browser login); only a running
 * Antigravity sign-in polls its own flow.
 *
 * Every read and sign-in here goes to this computer. The card hands its rail
 * one machine scope, and each call takes the pin from it (null: the unpinned
 * route, which reaches this computer while the front tab is bound here). A
 * front tab on another machine would take the unpinned calls there, so the
 * card leaves itself out then, as `useFirstRunSteps`' `skipAgents` does.
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
  /** A refresh asked for while one ran: that one may have read before the change, so it reads again. */
  const pendingRef = useRef(false);
  // The top grid's order, fixed at the first answer, so a sign-in changes a
  // tile in place instead of reshuffling the grid under the pointer.
  const [order, setOrder] = useState<SettingsProviderId[] | null>(null);
  const remoteTab = useAppStore((state) => state.projectBinding?.kind === "remote");
  const scope = useMemo(
    () =>
      settingsMachineScope({
        machineId: THIS_MACHINE_ID,
        machineName: machineName ?? THIS_MACHINE_NAME,
        target: { kind: "this" },
        isThisMachine: true,
        isActiveBinding: true,
        online: true,
      }),
    [machineName],
  );
  const pin = scope.pin;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  // No forced read: a successful sign-in clears the status cache, and the
  // rail runs the provider's own check before it asks for this refresh.
  const refresh = useCallback(async () => {
    if (loadingRef.current) {
      pendingRef.current = true;
      return;
    }
    loadingRef.current = true;
    try {
      do {
        pendingRef.current = false;
        try {
          const next = await window.ade.ai.getStatus(undefined, pinRef.current);
          setStatus(next);
          setFailed(false);
        } catch {
          setFailed(true);
        }
      } while (pendingRef.current);
    } finally {
      loadingRef.current = false;
    }
  }, []);
  const refreshAfterSignIn = useCallback(() => void refresh(), [refresh]);

  // The front tab moved to another machine while the card was open: go on to
  // the projects rather than read or sign in there under this computer's name.
  useEffect(() => {
    if (remoteTab) onDone();
  }, [onDone, remoteTab]);

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

  const pinKey = pin?.key ?? null;
  useEffect(() => {
    if (remoteTab) return undefined;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [pinKey, refresh, remoteTab]);

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
      </header>

      <section className="ade-fr-list" aria-label="Coding agents on this computer">
        <SettingsMachineScopeProvider scope={scope}>
          <FirstRunAgentRail primary={primary} later={later} onChanged={refreshAfterSignIn} />
        </SettingsMachineScopeProvider>
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
