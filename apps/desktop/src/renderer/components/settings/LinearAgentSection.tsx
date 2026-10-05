import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowSquareOut, CircleNotch, Robot } from "@phosphor-icons/react";
import type { AiPermissionSettings, LinearAgentOverview, ModelConfig } from "../../../shared/types";
import { getAppDefaultModelDescriptor, getDefaultModelDescriptor, getModelById } from "../../../shared/modelRegistry";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { useModelRecents } from "../shared/ModelPicker/useModelRecents";
import { permissionControlsForModel, patchPermissionConfig, selectedPermissionMode } from "../automations/permissionControls";
import { navigateToAppTarget } from "../../lib/openExternal";
import { confirmDialog } from "../ui/dialog";
import { Banner } from "../ui/notice/Banner";
import { LINEAR_BRAND, LinearMark } from "../lanes/linearBrand";
import { relativeTimeCompact } from "../../lib/format";
import { buildLinearAgentRuleDraft } from "../automations/templates/templateData";

const INSTALL_POLL_MS = 1_500;

const LABEL: React.CSSProperties = { fontSize: 11, fontWeight: 500, fontFamily: SANS_FONT, color: COLORS.textMuted };
const HINT: React.CSSProperties = { fontSize: 11.5, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "17px" };
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
      draft: buildLinearAgentRuleDraft({ name: "Linear agent — delegations", trigger: "linear.agent_delegated", laneMode: "create", modelConfig, permissionConfig }),
    });
    if (answerMentions) {
      try {
        await automations.saveDraft({
          draft: buildLinearAgentRuleDraft({ name: "Linear agent — mentions", trigger: "linear.agent_mentioned", laneMode: "reuse", modelConfig, permissionConfig }),
        });
      } catch (err) {
        // Show the saved delegations rule, so a retry does not add it twice.
        await load();
        throw new Error(`The delegations rule is on, but the mentions rule was not saved: ${err instanceof Error ? err.message : String(err)}. Add it in Automations.`);
      }
    }
  }), [answerMentions, effectiveModelId, effort, hasReasoning, load, permissionConfig, run]);

  const handleRemove = useCallback(async () => {
    const orgName = overview?.status?.orgName ?? "this workspace";
    const confirmed = await confirmDialog({
      title: "Remove the ADE agent?",
      message: `Delegations to ADE stop for everyone in ${orgName}. Lanes and chats it started stay in ADE.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (confirmed) await run("uninstall", () => ctoApi().uninstallLinearAgent());
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
          <span style={{ marginTop: 1, color: LINEAR_BRAND.primary }}><Robot size={16} weight="duotone" /></span>
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
        <Banner
          layout="inline"
          model={{ id: "linear-agent-error", tone: "error", icon: <LinearMark size={14} />, title: error }}
        />
      ) : null}

      {overview && !overview.available ? (
        <Banner
          layout="inline"
          model={{
            id: "linear-agent-unreachable",
            tone: "warning",
            icon: <LinearMark size={14} />,
            title: "The ADE agent service is not reachable",
            detail: `${overview.message ?? "No answer from the relay."} Sign in to ADE in Settings → Account.`,
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
            title: "Your Linear delegations go to another ADE account",
            detail: "Linear sends the issues you delegate to ADE to a different ADE sign-in. Route them here to run them on this account's machines.",
            actions: [{
              label: busy === "member" ? "Routing…" : "Route to this account",
              variant: "secondary",
              onClick: () => void run("member", () => ctoApi().registerLinearAgentMember({ replace: true })),
            }],
          }}
        />
      ) : null}

      {status && !installed ? (
        <div style={HINT}>A Linear workspace admin approves the install once. Teammates only connect Linear in their own ADE.</div>
      ) : null}

      {installed && rules.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14, borderRadius: 10, background: "color-mix(in srgb, var(--color-fg) 2.5%, transparent)", border: `1px solid ${COLORS.border}` }}>
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
                void run("settings", () => ctoApi().updateLinearAgentSettings({ fallbackMode: mode, runner: mode === "runner" ? "self" : null }));
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
              <span style={{ color: COLORS.textDim }}>{relativeTimeCompact(session.startedAt) || "—"} · Open chat</span>
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
