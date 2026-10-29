import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowSquareOut, Check, CircleNotch, Robot } from "@phosphor-icons/react";
import type { AiPermissionSettings, LinearAgentOverview, ModelConfig, OpenProjectBinding } from "../../../shared/types";
import { getAppDefaultModelDescriptor, getDefaultModelDescriptor, getModelById } from "../../../shared/modelRegistry";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { useModelRecents } from "../shared/ModelPicker/useModelRecents";
import { RulePermissionPicker } from "../automations/RulePermissionPicker";
import { navigateToAppTarget } from "../../lib/openExternal";
import { confirmDialog } from "../ui/dialog";
import { Banner } from "../ui/notice/Banner";
import { LinearMark } from "../lanes/linearBrand";
import { relativeTimeCompact } from "../../lib/format";
import { buildLinearAgentRuleDraft } from "../automations/templates/templateData";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { IntegrationCard } from "./integrations/IntegrationChrome";

const INSTALL_POLL_MS = 1_500;

const LABEL: React.CSSProperties = { fontSize: 11, fontWeight: 500, fontFamily: SANS_FONT, color: COLORS.textMuted };
const TEXT: React.CSSProperties = { fontSize: 12.5, fontFamily: SANS_FONT, color: COLORS.textSecondary };

function ctoApi() {
  const api = window.ade?.cto;
  if (!api) throw new Error("ADE is still starting. Try again in a moment.");
  return api;
}

function laneModeLabel(mode: string | null): string {
  if (mode === "create") return "New lane per issue";
  if (mode === "require-on-trigger") return "Lane from the trigger";
  return "Primary lane";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <span style={LABEL}>{label}</span>
      {children}
    </label>
  );
}

/**
 * The "ADE agent" card on Settings › Integrations › Linear. Installs
 * the agent in the workspace, makes this machine's delegation rules, and says
 * where delegations from teammates go.
 *
 * `pin` is the Settings page's machine: membership, rules and the install all
 * belong to that machine's runtime. Null follows the tab's binding.
 */
export function LinearAgentSection({ connected, pin = null }: { connected: boolean; pin?: OpenProjectBinding | null }) {
  const navigate = useNavigate();
  const [overview, setOverview] = useState<LinearAgentOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const installSessionRef = useRef<string | null>(null);
  const registeredOnceRef = useRef(false);

  const { recents } = useModelRecents();
  const suggestedModelId = useMemo(
    () => recents[0] ?? getAppDefaultModelDescriptor()?.id ?? getDefaultModelDescriptor("claude")?.id ?? "",
    [recents],
  );
  const [modelId, setModelId] = useState<string>("");
  const [effort, setEffort] = useState<string | null>(null);
  const [permissionConfig, setPermissionConfig] = useState<AiPermissionSettings | undefined>(undefined);
  const [answerMentions, setAnswerMentions] = useState(true);
  const effectiveModelId = modelId || suggestedModelId;
  const descriptor = effectiveModelId ? getModelById(effectiveModelId) : undefined;
  const hasReasoning = (descriptor?.reasoningTiers?.length ?? 0) > 0;

  const load = useCallback(async () => {
    const cto = window.ade?.cto;
    if (!cto?.getLinearAgentOverview) {
      setError("This version of ADE can't set up the agent.");
      return;
    }
    setLoading(true);
    try {
      let next = await cto.getLinearAgentOverview(pin);
      if (next.status && !next.status.me.registered && !registeredOnceRef.current) {
        registeredOnceRef.current = true;
        next = await cto.registerLinearAgentMember(undefined, pin).catch(() => next);
      }
      setOverview(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the ADE agent.");
    } finally {
      setLoading(false);
    }
  }, [pin]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);


  useEffect(() => {
    if (!installing) return;
    const timer = window.setInterval(() => {
      const sessionId = installSessionRef.current;
      const cto = window.ade?.cto;
      if (!sessionId || !cto?.getLinearAgentInstallSession) return;
      void cto.getLinearAgentInstallSession(sessionId, pin).then((session) => {
        if (session.status === "pending") return;
        installSessionRef.current = null;
        setInstalling(false);
        if (session.status === "completed") void load();
        else setError(session.error ?? "The install did not finish.");
      }).catch(() => {});
    }, INSTALL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [installing, load, pin]);

  const handleInstall = useCallback(async () => {
    const cto = window.ade?.cto;
    const openExternal = window.ade?.app?.openExternal;
    if (!cto?.startLinearAgentInstall || !openExternal) return;
    setError(null);
    setInstalling(true);
    try {
      const session = await cto.startLinearAgentInstall(pin);
      installSessionRef.current = session.sessionId;
      await openExternal(session.authUrl);
    } catch (err) {
      setInstalling(false);
      setError(err instanceof Error ? err.message : "Could not start the install.");
    }
  }, [pin]);

  const run = useCallback(async (key: string, work: () => Promise<LinearAgentOverview | void>) => {
    setBusy(key);
    setError(null);
    try {
      const next = await work();
      if (next) setOverview(next);
      else await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }, [load]);

  const handleTurnOn = useCallback(() => run("rule", async () => {
    const automations = window.ade?.automations;
    if (!isAdeAvailable(automations?.saveDraft)) throw new Error("Automations are not available in this ADE.");
    const modelConfig: ModelConfig = {
      modelId: effectiveModelId,
      ...(hasReasoning && effort ? { thinkingLevel: effort as ModelConfig["thinkingLevel"] } : {}),
    };
    await automations.saveDraft({
      draft: buildLinearAgentRuleDraft({ name: "Linear agent — delegations", trigger: "linear.agent_delegated", laneMode: "create", modelConfig, permissionConfig }),
    }, pin);
    if (answerMentions) {
      try {
        await automations.saveDraft({
          draft: buildLinearAgentRuleDraft({ name: "Linear agent — mentions", trigger: "linear.agent_mentioned", laneMode: "reuse", modelConfig, permissionConfig }),
        }, pin);
      } catch (err) {
        // Show the saved delegations rule, so a retry does not add it twice.
        await load();
        throw new Error(`The delegations rule is on, but the mentions rule was not saved: ${err instanceof Error ? err.message : String(err)}. Add it in Automations.`);
      }
    }
  }), [answerMentions, effectiveModelId, effort, hasReasoning, load, permissionConfig, pin, run]);

  const handleRemove = useCallback(async () => {
    const orgName = overview?.status?.orgName ?? "this workspace";
    const confirmed = await confirmDialog({
      title: "Remove the ADE agent?",
      message: `Delegations to ADE stop for everyone in ${orgName}. Lanes and chats it started stay in ADE.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (confirmed) await run("uninstall", () => ctoApi().uninstallLinearAgent(pin));
  }, [overview?.status?.orgName, pin, run]);

  // The last overview outlives a disconnect; while disconnected it says nothing.
  const live = connected ? overview : null;
  const status = live?.status ?? null;
  const installed = status?.installed === true;
  const rules = live?.rules ?? [];
  const otherMembers = status ? status.members.filter((member) => !member.isMe) : [];
  const unreachable = live != null && !live.available;
  const checking = connected && loading && !overview;
  const rulesDone = installed && rules.length > 0;

  const badge = !connected ? null
    : checking ? <span className="kit-tag">Checking…</span>
      : rulesDone ? <span className="kit-tag" data-tone="ok">On</span>
        : installed ? <span className="kit-tag" data-tone="warn">Pick a model</span>
          : status ? <span className="kit-tag">Not added</span> : null;

  return (
    <IntegrationCard
      icon={<Robot size={16} weight="duotone" />}
      title="ADE agent"
      hint="Your team assigns Linear issues to ADE, or mentions @ADE in a comment. Each one runs on the ADE of the person who asked."
      badge={badge}
      actions={rulesDone ? (
        <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" onClick={() => navigate("/automations")}>
          Automations
        </button>
      ) : null}
    >
      {error ? (
        <Banner layout="inline" model={{ id: "linear-agent-error", tone: "error", icon: <LinearMark size={14} />, title: error }} />
      ) : null}
      {unreachable ? (
        <Banner
          layout="inline"
          model={{
            id: "linear-agent-unreachable",
            tone: "warning",
            icon: <LinearMark size={14} />,
            title: "Can't reach the ADE agent service",
            detail: `${overview?.message ?? "No answer from the relay."} Sign in to ADE in Settings › Account.`,
          }}
        />
      ) : null}
      {status?.me.routedToOtherAccount ? (
        <Banner
          layout="inline"
          model={{
            id: "linear-agent-other-account",
            tone: "warning",
            icon: <LinearMark size={14} />,
            title: "Issues you assign to ADE go to another ADE account",
            detail: "Linear sends them to a different ADE sign-in. Route them here to run them on this account's machines.",
            actions: [{
              label: busy === "member" ? "Routing…" : "Route to this account",
              variant: "secondary",
              onClick: () => void run("member", () => ctoApi().registerLinearAgentMember({ replace: true }, pin)),
            }],
          }}
        />
      ) : null}

      <ol className="ade-ig-steps">
        <li className="ade-ig-step" data-done={installed ? "true" : undefined} data-waiting={!connected ? "true" : undefined}>
          <span className="ade-ig-step-num" aria-hidden>{installed ? <Check size={11} weight="bold" /> : 1}</span>
          <div className="ade-ig-step-main">
            <div className="ade-ig-step-head">
              <b>Add ADE to your workspace</b>
              {checking ? <CircleNotch size={12} className="animate-spin" style={{ color: "var(--color-muted-fg)" }} /> : null}
            </div>
            <p className="ade-ig-note">
              {!connected
                ? "Connect Linear first."
                : installed
                  ? `Added to ${status?.orgName ?? "this workspace"}.`
                  : "A workspace admin approves it once. After that, teammates only connect Linear in their own ADE."}
            </p>
            {connected && !installed && status ? (
              <div className="ade-ig-step-actions">
                <button type="button" className="ade-modern-btn" data-tone="primary" disabled={installing} onClick={() => void handleInstall()}>
                  {installing ? <CircleNotch size={12} className="animate-spin" /> : <ArrowSquareOut size={12} />}
                  {installing ? "Waiting for Linear…" : "Add to workspace"}
                </button>
              </div>
            ) : null}
          </div>
        </li>

        <li className="ade-ig-step" data-done={rulesDone ? "true" : undefined} data-waiting={!installed ? "true" : undefined}>
          <span className="ade-ig-step-num" aria-hidden>{rulesDone ? <Check size={11} weight="bold" /> : 2}</span>
          <div className="ade-ig-step-main">
            <div className="ade-ig-step-head"><b>Choose the model that works your issues</b></div>
            {!installed ? (
              <p className="ade-ig-note">ADE won&rsquo;t pick one for you. Each assigned issue gets its own lane.</p>
            ) : rules.length === 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: hasReasoning ? "minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1.6fr) minmax(0, 1fr)",
                    gap: 10,
                    alignItems: "start",
                  }}
                >
                  <Field label="Model">
                    <ModelPicker value={effectiveModelId} onChange={(next) => { setModelId(next); setEffort(null); }} hidePermissionRail triggerClassName="w-full justify-between" />
                  </Field>
                  {hasReasoning ? (
                    <Field label="Reasoning">
                      <ReasoningEffortPicker modelId={effectiveModelId} reasoningEffort={effort} onChange={setEffort} triggerClassName="w-full justify-between" />
                    </Field>
                  ) : null}
                  <Field label="Permissions">
                    <RulePermissionPicker modelId={effectiveModelId} permissionConfig={permissionConfig} onChange={setPermissionConfig} />
                  </Field>
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, ...TEXT, fontSize: 12 }}>
                    <input type="checkbox" checked={answerMentions} onChange={(event) => setAnswerMentions(event.target.checked)} />
                    Also answer @ADE mentions
                  </label>
                  <button
                    type="button"
                    className="ade-modern-btn"
                    data-tone="primary"
                    disabled={!effectiveModelId || !descriptor || busy === "rule"}
                    onClick={handleTurnOn}
                  >
                    {busy === "rule" ? <CircleNotch size={12} className="animate-spin" /> : null}
                    Turn on
                  </button>
                </div>
                <p className="ade-ig-note">
                  Adds {answerMentions ? "two rules" : "a rule"} to Automations on this machine. If the model isn&rsquo;t available when an issue arrives, Linear says why.
                </p>
              </div>
            ) : (
              <div className="ade-ig-mini-rows">
                {rules.map((rule) => {
                  const kind = rule.triggerTypes.includes("linear.agent_mentioned") && !rule.triggerTypes.includes("linear.agent_delegated") ? "Mentions" : "Assigned issues";
                  const model = rule.modelId ? (getModelById(rule.modelId)?.displayName ?? rule.modelId) : null;
                  return (
                    <div key={rule.id} className="ade-ig-mini-row">
                      <span className="kit-dot" data-state={rule.enabled ? "ok" : undefined} />
                      <span className="ade-ig-mini-title">{kind}</span>
                      <span className="ade-ig-mini-detail">
                        {model ?? <span className="kit-tag" data-tone="crit">No model</span>} · {laneModeLabel(rule.laneMode)}{rule.enabled ? "" : " · off"}
                      </span>
                      <button
                        type="button"
                        className="ade-modern-btn"
                        data-variant="ghost"
                        data-size="sm"
                        onClick={() => navigate(`/automations?rule=${encodeURIComponent(rule.id)}`)}
                      >
                        Edit
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </li>

        <li className="ade-ig-step" data-waiting={!rulesDone ? "true" : undefined}>
          <span className="ade-ig-step-num" aria-hidden>3</span>
          <div className="ade-ig-step-main">
            <div className="ade-ig-step-head"><b>Assign issues to ADE in Linear</b></div>
            <p className="ade-ig-note">
              {installed && status
                ? otherMembers.length === 0
                  ? "You're the only one using ADE in this workspace so far."
                  : `Also using ADE: ${otherMembers.map((member) => member.displayName ?? "someone").join(", ")}. Their issues run on their own ADE.`
                : "Or write @ADE in a comment. ADE replies in Linear as it works."}
            </p>
            {installed && status ? (
              <div className="ade-ig-inline-field">
                <span>When someone without ADE assigns one</span>
                <select
                  className="ade-settings-input"
                  aria-label="When someone who does not use ADE assigns an issue"
                  style={{ height: 28, width: "auto", minWidth: 190 }}
                  disabled={!status.installedByMe || busy === "settings"}
                  value={status.fallbackMode}
                  title={status.installedByMe ? undefined : "Only the person who added the agent can change this."}
                  onChange={(event) => {
                    const mode = event.target.value === "runner" ? "runner" : "reply";
                    void run("settings", () => ctoApi().updateLinearAgentSettings({ fallbackMode: mode, runner: mode === "runner" ? "self" : null }, pin));
                  }}
                >
                  <option value="reply">Reply that they need ADE</option>
                  <option value="runner">Run it on my ADE</option>
                </select>
              </div>
            ) : null}
            {installed && (overview?.activeSessions.length ?? 0) > 0 ? (
              <div className="ade-ig-mini-rows">
                {overview!.activeSessions.slice(0, 5).map((session) => (
                  <button
                    key={session.agentSessionId}
                    type="button"
                    className="ade-ig-mini-row ade-ig-mini-link"
                    onClick={() => navigateToAppTarget({ kind: "chat", sessionId: session.chatSessionId, laneId: session.laneId })}
                  >
                    <span className="ade-ig-mono">{session.issueIdentifier ?? "Issue"}</span>
                    <span className="ade-ig-mini-detail">{relativeTimeCompact(session.startedAt) || "—"}</span>
                    <span className="ade-ig-link">Open chat</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </li>
      </ol>

      {installed && status?.installedByMe ? (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "auto" }}>
          <button
            type="button"
            className="ade-modern-btn ade-linear-remove"
            data-variant="ghost"
            data-size="sm"
            disabled={busy === "uninstall"}
            onClick={() => void handleRemove()}
          >
            Remove from workspace
          </button>
        </div>
      ) : null}
    </IntegrationCard>
  );
}
