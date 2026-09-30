import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowSquareOut, CircleNotch, Robot, Warning } from "@phosphor-icons/react";
import type { AiPermissionSettings, AutomationRuleDraft, LinearAgentOverview, ModelConfig } from "../../../shared/types";
import { getAppDefaultModelDescriptor, getDefaultModelDescriptor, getModelById } from "../../../shared/modelRegistry";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { useModelRecents } from "../shared/ModelPicker/useModelRecents";
import { permissionControlsForModel, patchPermissionConfig, selectedPermissionMode } from "../automations/permissionControls";
import { defaultKickoffPrompt } from "../../lib/linearBatchLaunch";
import { navigateToAppTarget } from "../../lib/openExternal";
import { confirmDialog } from "../ui/dialog";

const LINEAR_BRAND = "#5E6AD2";
const INSTALL_POLL_MS = 1_500;

const AGENT_RULE_PROMPT = [
  defaultKickoffPrompt(),
  "",
  "You were started from Linear. Keep the person who asked informed: when you need a decision, ask it as a question (they answer in Linear); when you finish, end with a short summary of what changed and the PR link.",
].join("\n");

const LABEL: React.CSSProperties = { fontSize: 11, fontWeight: 500, fontFamily: SANS_FONT, color: COLORS.textMuted };
const HINT: React.CSSProperties = { fontSize: 11.5, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "17px" };
const TEXT: React.CSSProperties = { fontSize: 12.5, fontFamily: SANS_FONT, color: COLORS.textSecondary };

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function laneModeLabel(mode: string | null): string {
  if (mode === "create") return "New lane per issue";
  if (mode === "require-on-trigger") return "Lane from the trigger";
  return "Primary lane";
}

function buildAgentRuleDraft(args: {
  name: string;
  trigger: "linear.agent_delegated" | "linear.agent_mentioned";
  laneMode: "create" | "reuse";
  modelConfig: ModelConfig;
  permissionConfig: AiPermissionSettings | undefined;
}): AutomationRuleDraft {
  const trigger = { type: args.trigger } as const;
  return {
    name: args.name,
    description: args.trigger === "linear.agent_delegated"
      ? "Runs when a Linear delegation to ADE reaches this ADE."
      : "Answers when an @ADE mention in Linear reaches this ADE.",
    enabled: true,
    mode: args.trigger === "linear.agent_delegated" ? "fix" : "monitor",
    triggers: [trigger],
    trigger,
    execution: { kind: "agent-session", laneMode: args.laneMode, session: {} },
    executor: { mode: "automation-bot" },
    modelConfig: args.modelConfig,
    ...(args.permissionConfig ? { permissionConfig: args.permissionConfig } : {}),
    prompt: args.trigger === "linear.agent_delegated"
      ? AGENT_RULE_PROMPT
      : "Answer the question in the mention. Read code as needed, but do not change files unless they ask you to.",
    reviewProfile: "quick",
    toolPalette: ["repo", "git"],
    contextSources: [],
    guardrails: {},
    outputs: { disposition: "comment-only", createArtifact: true },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: "auto:linear-agent",
    actions: [],
    legacyActions: [],
  } as AutomationRuleDraft;
}

function StatusDot({ on, label }: { on: boolean; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontFamily: SANS_FONT, color: on ? COLORS.textSecondary : COLORS.textDim }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: on ? COLORS.success : COLORS.textDim }} />
      {label}
    </span>
  );
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
 * The "ADE agent" part of the Linear card in Settings → Integrations. Installs
 * the agent in the workspace, makes this machine's delegation rules, and says
 * where delegations from teammates go.
 */
export function LinearAgentSection({ connected }: { connected: boolean }) {
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
  const permissionMeta = effectiveModelId ? permissionControlsForModel(effectiveModelId) : null;

  const load = useCallback(async () => {
    const cto = window.ade?.cto;
    if (!cto?.getLinearAgentOverview) return;
    setLoading(true);
    try {
      let next = await cto.getLinearAgentOverview();
      if (next.status && !next.status.me.registered && !registeredOnceRef.current) {
        registeredOnceRef.current = true;
        next = await cto.registerLinearAgentMember().catch(() => next);
      }
      setOverview(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the ADE agent.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  useEffect(() => {
    if (!installing) return;
    const timer = window.setInterval(() => {
      const sessionId = installSessionRef.current;
      const cto = window.ade?.cto;
      if (!sessionId || !cto?.getLinearAgentInstallSession) return;
      void cto.getLinearAgentInstallSession(sessionId).then((session) => {
        if (session.status === "pending") return;
        installSessionRef.current = null;
        setInstalling(false);
        if (session.status === "completed") void load();
        else setError(session.error ?? "The install did not finish.");
      }).catch(() => {});
    }, INSTALL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [installing, load]);

  const handleInstall = useCallback(async () => {
    const cto = window.ade?.cto;
    const openExternal = window.ade?.app?.openExternal;
    if (!cto?.startLinearAgentInstall || !openExternal) return;
    setError(null);
    setInstalling(true);
    try {
      const session = await cto.startLinearAgentInstall();
      installSessionRef.current = session.sessionId;
      await openExternal(session.authUrl);
    } catch (err) {
      setInstalling(false);
      setError(err instanceof Error ? err.message : "Could not start the install.");
    }
  }, []);

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
    if (!automations?.saveDraft) throw new Error("Automations are not available in this ADE.");
    const modelConfig: ModelConfig = {
      modelId: effectiveModelId,
      ...(hasReasoning && effort ? { thinkingLevel: effort as ModelConfig["thinkingLevel"] } : {}),
    };
    await automations.saveDraft({
      draft: buildAgentRuleDraft({ name: "Linear agent — delegations", trigger: "linear.agent_delegated", laneMode: "create", modelConfig, permissionConfig }),
    });
    if (answerMentions) {
      await automations.saveDraft({
        draft: buildAgentRuleDraft({ name: "Linear agent — mentions", trigger: "linear.agent_mentioned", laneMode: "reuse", modelConfig, permissionConfig }),
      });
    }
  }), [answerMentions, effectiveModelId, effort, hasReasoning, permissionConfig, run]);

  const handleRemove = useCallback(async () => {
    const orgName = overview?.status?.orgName ?? "this workspace";
    const confirmed = await confirmDialog({
      title: "Remove the ADE agent?",
      message: `Delegations to ADE stop for everyone in ${orgName}. Lanes and chats it started stay in ADE.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (confirmed) await run("uninstall", () => window.ade.cto!.uninstallLinearAgent());
  }, [overview?.status?.orgName, run]);

  if (!connected) return null;

  const status = overview?.status ?? null;
  const installed = status?.installed === true;
  const rules = overview?.rules ?? [];
  const otherMembers = status ? status.members.filter((member) => !member.isMe) : [];

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 14 }} aria-label="ADE agent">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
          <span style={{ marginTop: 1, color: LINEAR_BRAND }}><Robot size={16} weight="duotone" /></span>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>ADE agent</span>
              {loading && !overview ? <CircleNotch size={12} className="animate-spin" style={{ color: COLORS.textMuted }} />
                : installed ? <StatusDot on label="Installed" />
                  : status ? <StatusDot on={false} label="Not installed" /> : null}
            </div>
            <div style={{ ...HINT, marginTop: 3 }}>
              Assign an issue to ADE in Linear, or write @ADE in a comment. The work runs on the ADE of the person who asked.
            </div>
          </div>
        </div>
        {installed && rules.length > 0 ? (
          <button type="button" className="ade-settings-button" style={{ flexShrink: 0 }} onClick={() => navigate("/automations")}>
            Automations
          </button>
        ) : !installed && status ? (
          <button
            type="button"
            className="ade-settings-button"
            data-variant="primary"
            style={{ flexShrink: 0, gap: 6 }}
            disabled={installing}
            onClick={() => void handleInstall()}
          >
            {installing ? <CircleNotch size={12} className="animate-spin" /> : <ArrowSquareOut size={12} />}
            {installing ? "Waiting for Linear…" : "Install"}
          </button>
        ) : null}
      </div>

      {error ? (
        <div role="alert" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, fontFamily: SANS_FONT, color: COLORS.danger }}>
          <Warning size={14} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      ) : null}

      {overview && !overview.available ? (
        <div style={HINT}>{overview.message ?? "The ADE agent service is not reachable."} Sign in to ADE in Settings → Account.</div>
      ) : null}

      {status && !installed ? (
        <div style={HINT}>A Linear workspace admin approves the install once. Teammates only connect Linear in their own ADE.</div>
      ) : null}

      {installed && rules.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14, borderRadius: 10, background: "rgba(255,255,255,0.025)", border: `1px solid ${COLORS.border}` }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>Choose the model for your delegations</div>
            <div style={{ ...HINT, marginTop: 2 }}>
              ADE never picks a model on its own. If this one is unavailable when a delegation arrives, Linear shows why.
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: hasReasoning ? "minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1.6fr) minmax(0, 1fr)",
              gap: 12,
              alignItems: "end",
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
              <select
                className="ade-settings-input"
                style={{ height: 32 }}
                disabled={!permissionMeta}
                value={permissionMeta ? selectedPermissionMode(permissionConfig, effectiveModelId) : ""}
                onChange={(event) => setPermissionConfig(patchPermissionConfig(permissionConfig, effectiveModelId, event.target.value))}
              >
                <option value="">Rule default</option>
                {(permissionMeta?.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, ...TEXT, fontSize: 12 }}>
              <input type="checkbox" checked={answerMentions} onChange={(event) => setAnswerMentions(event.target.checked)} />
              Also answer @ADE mentions
            </label>
            <button
              type="button"
              className="ade-settings-button"
              data-variant="primary"
              disabled={!effectiveModelId || !descriptor || busy === "rule"}
              onClick={handleTurnOn}
            >
              {busy === "rule" ? <CircleNotch size={12} className="animate-spin" /> : null}
              Turn on
            </button>
          </div>
          <div style={{ ...HINT, fontSize: 11 }}>
            This adds {answerMentions ? "two rules" : "one rule"} to Automations on this machine. Delegations get a new lane per issue with Linear’s branch name{answerMentions ? "; mentions answer in the primary lane" : ""}.
          </div>
        </div>
      ) : null}

      {installed && rules.length > 0 ? (
        <div style={{ borderRadius: 10, border: `1px solid ${COLORS.border}`, overflow: "hidden" }}>
          {rules.map((rule, index) => {
            const kind = rule.triggerTypes.includes("linear.agent_mentioned") && !rule.triggerTypes.includes("linear.agent_delegated") ? "Mentions" : "Delegations";
            const model = rule.modelId ? (getModelById(rule.modelId)?.displayName ?? rule.modelId) : null;
            return (
              <div
                key={rule.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "96px minmax(0, 1fr) auto auto",
                  alignItems: "center",
                  gap: 12,
                  padding: "9px 12px",
                  borderTop: index === 0 ? "none" : `1px solid ${COLORS.border}`,
                }}
              >
                <span style={{ ...TEXT, color: COLORS.textPrimary, fontWeight: 500 }}>{kind}</span>
                <span style={{ ...TEXT, fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {model ?? <span style={{ color: COLORS.danger }}>No model</span>}
                  <span style={{ color: COLORS.textDim }}> · {laneModeLabel(rule.laneMode)}</span>
                </span>
                <StatusDot on={rule.enabled} label={rule.enabled ? "On" : "Off"} />
                <button
                  type="button"
                  className="ade-settings-button"
                  data-variant="ghost"
                  onClick={() => navigate(`/automations?rule=${encodeURIComponent(rule.id)}`)}
                >
                  Edit
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {installed && status ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={TEXT}>
            <span style={{ color: COLORS.textPrimary, fontWeight: 500 }}>Teammates.</span>{" "}
            {otherMembers.length === 0
              ? "Only you use ADE in this workspace so far."
              : `${otherMembers.length} ${otherMembers.length === 1 ? "teammate uses" : "teammates use"} ADE: ${otherMembers.map((member) => member.displayName ?? "someone").join(", ")}.`}{" "}
            Their delegations run on their own ADE, with their own rules.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ ...TEXT, fontSize: 12 }}>When someone who does not use ADE delegates:</span>
            <select
              className="ade-settings-input"
              style={{ height: 30, width: "auto", minWidth: 220 }}
              disabled={!status.installedByMe || busy === "settings"}
              value={status.fallbackMode}
              title={status.installedByMe ? undefined : "Only the person who installed the agent can change this."}
              onChange={(event) => {
                const mode = event.target.value === "runner" ? "runner" : "reply";
                void run("settings", () => window.ade.cto!.updateLinearAgentSettings({ fallbackMode: mode, runner: mode === "runner" ? "self" : null }));
              }}
            >
              <option value="reply">Reply that they need ADE</option>
              <option value="runner">Run it on my ADE</option>
            </select>
          </div>
          {status.fallbackMode === "runner" && status.runnerIsMe ? (
            <div style={HINT}>Those delegations use your rules above.</div>
          ) : null}
        </div>
      ) : null}

      {installed && (overview?.activeSessions.length ?? 0) > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={LABEL}>Recent</span>
          {overview!.activeSessions.slice(0, 5).map((session) => (
            <button
              key={session.agentSessionId}
              type="button"
              onClick={() => navigateToAppTarget({ kind: "chat", sessionId: session.chatSessionId, laneId: session.laneId })}
              style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", background: "none", border: "none", cursor: "pointer", ...TEXT, fontSize: 12 }}
            >
              <span style={{ color: COLORS.textPrimary }}>{session.issueIdentifier ?? "Issue"}</span>
              <span style={{ color: COLORS.textDim }}>{relativeTime(session.startedAt)} · Open chat</span>
            </button>
          ))}
        </div>
      ) : null}

      {installed && status?.installedByMe ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            disabled={busy === "uninstall"}
            onClick={() => void handleRemove()}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim, padding: "2px 0" }}
            onMouseEnter={(event) => { event.currentTarget.style.color = COLORS.danger; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = COLORS.textDim; }}
          >
            Remove ADE agent from this workspace
          </button>
        </div>
      ) : null}
    </section>
  );
}
