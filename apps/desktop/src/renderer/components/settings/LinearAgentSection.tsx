import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowSquareOut, CircleNotch, Robot } from "@phosphor-icons/react";
import type { AiPermissionSettings, LinearAgentOverview, ModelConfig, OpenProjectBinding } from "../../../shared/types";
import { getAppDefaultModelDescriptor, getDefaultModelDescriptor, getModelById } from "../../../shared/modelRegistry";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { useModelRecents } from "../shared/ModelPicker/useModelRecents";
import { permissionControlsForModel, patchPermissionConfig, selectedPermissionMode } from "../automations/permissionControls";
import { navigateToAppTarget } from "../../lib/openExternal";
import { confirmDialog } from "../ui/dialog";
import { Banner } from "../ui/notice/Banner";
import { LinearMark } from "../lanes/linearBrand";
import { relativeTimeCompact } from "../../lib/format";
import { buildLinearAgentRuleDraft } from "../automations/templates/templateData";

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

function StatusDot({ on, label }: { on: boolean; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: on ? "var(--color-fg)" : "var(--color-muted-fg)" }}>
      <span className="kit-dot" data-state={on ? "ok" : undefined} />
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
  const permissionMeta = effectiveModelId ? permissionControlsForModel(effectiveModelId) : null;

  const load = useCallback(async () => {
    const cto = window.ade?.cto;
    if (!cto?.getLinearAgentOverview) return;
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
    if (!automations?.saveDraft) throw new Error("Automations are not available in this ADE.");
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

  if (!connected) return null;

  const status = overview?.status ?? null;
  const installed = status?.installed === true;
  const rules = overview?.rules ?? [];
  const otherMembers = status ? status.members.filter((member) => !member.isMe) : [];

  const statusTag = loading && !overview
    ? <CircleNotch size={12} className="animate-spin" style={{ color: "var(--color-muted-fg)" }} />
    : installed ? <span className="kit-tag" data-tone="ok">Installed</span>
      : status ? <span className="kit-tag">Not installed</span> : null;

  return (
    <section className="ade-ap-section" data-settings-group="Linear" aria-label="ADE agent">
      <header className="ade-ap-head">
        <div style={{ minWidth: 0 }}>
          <h2>ADE agent</h2>
          <p>Assign an issue to ADE in Linear, or write @ADE in a comment. The work runs on the ADE of the person who asked.</p>
        </div>
        <div className="ade-ap-actions" style={{ gap: 8 }}>
          {statusTag}
          {installed && rules.length > 0 ? (
            <button type="button" className="ade-modern-btn" onClick={() => navigate("/automations")}>
              Automations
            </button>
          ) : !installed && status ? (
            <button
              type="button"
              className="ade-modern-btn"
              data-tone="primary"
              disabled={installing}
              onClick={() => void handleInstall()}
            >
              {installing ? <CircleNotch size={12} className="animate-spin" /> : <ArrowSquareOut size={12} />}
              {installing ? "Waiting for Linear…" : "Install"}
            </button>
          ) : null}
        </div>
      </header>

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
              onClick: () => void run("member", () => ctoApi().registerLinearAgentMember({ replace: true }, pin)),
            }],
          }}
        />
      ) : null}

      {status && !installed ? (
        <div className="ade-ap-rowcard">
          <span className="ade-modern-glyph" aria-hidden><Robot size={16} weight="duotone" /></span>
          <div style={{ minWidth: 0, flex: 1 }} className="ade-ap-rowhint">
            A Linear workspace admin approves the install once. Teammates only connect Linear in their own ADE.
          </div>
        </div>
      ) : null}

      {installed && rules.length === 0 ? (
        <div className="ade-ap-rowcard" style={{ flexDirection: "column", alignItems: "stretch", gap: 14 }}>
          <div>
            <div className="ade-ap-rowtitle">Choose the model for your delegations</div>
            <div className="ade-ap-rowhint">
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
          <div className="ade-ap-rowhint">
            This adds {answerMentions ? "two rules" : "one rule"} to Automations on this machine. Delegations get a new lane per issue with Linear’s branch name{answerMentions ? "; mentions answer in the primary lane" : ""}.
          </div>
        </div>
      ) : null}

      {installed && rules.length > 0 ? (
        <div className="ade-modern-rows">
          {rules.map((rule) => {
            const kind = rule.triggerTypes.includes("linear.agent_mentioned") && !rule.triggerTypes.includes("linear.agent_delegated") ? "Mentions" : "Delegations";
            const model = rule.modelId ? (getModelById(rule.modelId)?.displayName ?? rule.modelId) : null;
            return (
              <div key={rule.id} className="ade-linear-rule-row">
                <span className="ade-ap-rowtitle">{kind}</span>
                <span className="ade-linear-rule-model">
                  {model ?? <span className="kit-tag" data-tone="crit">No model</span>}
                  <span style={{ color: "var(--color-muted-fg)" }}> · {laneModeLabel(rule.laneMode)}</span>
                </span>
                <StatusDot on={rule.enabled} label={rule.enabled ? "On" : "Off"} />
                <button
                  type="button"
                  className="ade-modern-btn"
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
        <div className="ade-modern-rows">
          <div className="ade-int-row">
            <div className="ade-int-row-copy">
              <div className="ade-ap-rowtitle">Teammates</div>
              <div className="ade-ap-rowhint">
                {otherMembers.length === 0
                  ? "Only you use ADE in this workspace so far."
                  : `${otherMembers.length} ${otherMembers.length === 1 ? "teammate uses" : "teammates use"} ADE: ${otherMembers.map((member) => member.displayName ?? "someone").join(", ")}.`}{" "}
                Their delegations run on their own ADE, with their own rules.
              </div>
            </div>
          </div>
          <div className="ade-int-row">
            <div className="ade-int-row-copy">
              <div className="ade-ap-rowtitle">When someone without ADE delegates</div>
              {status.fallbackMode === "runner" && status.runnerIsMe ? (
                <div className="ade-ap-rowhint">Those delegations use your rules above.</div>
              ) : null}
            </div>
            <select
              className="ade-settings-input"
              aria-label="When someone who does not use ADE delegates"
              style={{ height: 30, width: "auto", minWidth: 220 }}
              disabled={!status.installedByMe || busy === "settings"}
              value={status.fallbackMode}
              title={status.installedByMe ? undefined : "Only the person who installed the agent can change this."}
              onChange={(event) => {
                const mode = event.target.value === "runner" ? "runner" : "reply";
                void run("settings", () => ctoApi().updateLinearAgentSettings({ fallbackMode: mode, runner: mode === "runner" ? "self" : null }, pin));
              }}
            >
              <option value="reply">Reply that they need ADE</option>
              <option value="runner">Run it on my ADE</option>
            </select>
          </div>
        </div>
      ) : null}

      {installed && (overview?.activeSessions.length ?? 0) > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="kit-eyebrow">Recent</span>
          <div className="ade-modern-rows">
            {overview!.activeSessions.slice(0, 5).map((session) => (
              <button
                key={session.agentSessionId}
                type="button"
                className="ade-linear-recent"
                onClick={() => navigateToAppTarget({ kind: "chat", sessionId: session.chatSessionId, laneId: session.laneId })}
              >
                <span className="ade-int-mono" style={{ color: "var(--color-fg)" }}>{session.issueIdentifier ?? "Issue"}</span>
                <span style={{ color: "var(--color-muted-fg)" }}>{relativeTimeCompact(session.startedAt) || "—"} · Open chat</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {installed && status?.installedByMe ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="ade-modern-btn ade-linear-remove"
            data-variant="ghost"
            disabled={busy === "uninstall"}
            onClick={() => void handleRemove()}
          >
            Remove ADE agent from this workspace
          </button>
        </div>
      ) : null}
    </section>
  );
}
