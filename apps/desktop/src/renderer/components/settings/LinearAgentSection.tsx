import { plainErrorText } from "../../lib/plainError";
import { PRIMARY_LANE_DISPLAY_NAME } from "../../../shared/laneDisplayName";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowSquareOut, CaretDown, Check, CircleNotch, Copy, Robot } from "@phosphor-icons/react";
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
import { useThisComputerCopyPin } from "./ProjectCopyScope";
import { requirePin } from "../../state/repositoryScope";
import { showToast } from "../app/toast/toastStore";
import { BRAND } from "../../../shared/brand";

const INSTALL_POLL_MS = 1_500;

const LABEL: React.CSSProperties = { fontSize: 11, fontWeight: 500, fontFamily: SANS_FONT, color: COLORS.textMuted };
const TEXT: React.CSSProperties = { fontSize: 12.5, fontFamily: SANS_FONT, color: COLORS.textSecondary };

function ctoApi() {
  const api = window.ade?.cto;
  if (!api) throw new Error(`${BRAND.NAME} is still starting. Try again in a moment.`);
  return api;
}

function laneModeLabel(mode: string | null): string {
  if (mode === "create") return "New lane per issue";
  if (mode === "require-on-trigger") return "Lane from the trigger";
  return PRIMARY_LANE_DISPLAY_NAME;
}

function Field({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, ...(wide ? { gridColumn: "1 / -1" } : null) }}>
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
 *
 * `viewerIsAdmin` comes from the same machine's Linear connection. Linear lets
 * only workspace admins approve the agent, so a member is offered a note for
 * an admin instead of an Add that Linear would refuse. Null (unknown) keeps Add.
 */
export function LinearAgentSection({ connected, viewerIsAdmin = null, pin = null }: {
  connected: boolean;
  viewerIsAdmin?: boolean | null;
  pin?: OpenProjectBinding | null;
}) {
  const navigate = useNavigate();
  // The rules live in a copy of the project: the page machine's copy, or this
  // computer's copy when the page is about this computer.
  const thisComputerCopyPin = useThisComputerCopyPin();
  const rulePin = pin ?? thisComputerCopyPin;
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
      setError(`This version of ${BRAND.NAME} can't set up the agent.`);
      return;
    }
    setLoading(true);
    try {
      let next = await cto.getLinearAgentOverview(requirePin(pin));
      if (next.status && !next.status.me.registered && !registeredOnceRef.current) {
        registeredOnceRef.current = true;
        next = await cto.registerLinearAgentMember(undefined, requirePin(pin)).catch(() => next);
      }
      setOverview(next);
      setError(null);
    } catch (err) {
      setError(plainErrorText(err, `Could not load the ${BRAND.NAME} agent.`));
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
      if (!sessionId || !pin || !cto?.getLinearAgentInstallSession) return;
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
      const session = await cto.startLinearAgentInstall(requirePin(pin));
      installSessionRef.current = session.sessionId;
      await openExternal(session.authUrl);
    } catch (err) {
      setInstalling(false);
      setError(plainErrorText(err, "Could not start the install."));
    }
  }, [pin]);

  // The install sign-in returns to this computer, so an admin cannot finish it
  // from a link; they add ADE from their own ADE. The note also shows under
  // the button: a clipboard that fails quietly (the web client's) still
  // leaves the person something to send.
  const [adminNote, setAdminNote] = useState<string | null>(null);
  const copyNoteForAdmin = useCallback(async (workspace: string) => {
    const note = `Could you add the ${BRAND.NAME} agent to our Linear workspace (${workspace})? Linear lets only workspace admins approve it. In ${BRAND.NAME}, open Settings › Integrations › Linear and click "Add to workspace". After that, anyone on the team who uses ${BRAND.NAME} can assign issues to it.`;
    setAdminNote(note);
    const write = window.ade?.app?.writeClipboardText;
    try {
      if (!write) throw new Error("No clipboard here.");
      await write(note);
      showToast({ tone: "success", title: "Copied a note for an admin", message: "Send it to an admin of your Linear workspace." });
    } catch {
      showToast({ tone: "error", title: "Couldn't copy the note", message: "Copy it from under the button instead." });
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
      setError(plainErrorText(err, "That did not work."));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const handleTurnOn = useCallback(() => run("rule", async () => {
    const automations = window.ade?.automations;
    if (!isAdeAvailable(automations?.saveDraft)) throw new Error(`Automations are not available in this ${BRAND.NAME}.`);
    if (!rulePin) throw new Error("No computer with this project is online.");
    const modelConfig: ModelConfig = {
      modelId: effectiveModelId,
      ...(hasReasoning && effort ? { thinkingLevel: effort as ModelConfig["thinkingLevel"] } : {}),
    };
    await automations.saveDraft({
      draft: buildLinearAgentRuleDraft({ name: "Linear agent — delegations", trigger: "linear.agent_delegated", laneMode: "create", modelConfig, permissionConfig }),
    }, rulePin);
    if (answerMentions) {
      try {
        await automations.saveDraft({
          draft: buildLinearAgentRuleDraft({ name: "Linear agent — mentions", trigger: "linear.agent_mentioned", laneMode: "reuse", modelConfig, permissionConfig }),
        }, rulePin);
      } catch (err) {
        // Show the saved delegations rule, so a retry does not add it twice.
        await load();
        throw new Error(`The delegations rule is on, but the mentions rule was not saved: ${plainErrorText(err, `${BRAND.NAME} couldn't save the rule.`)}. Add it in Automations.`);
      }
    }
  }), [answerMentions, effectiveModelId, effort, hasReasoning, load, permissionConfig, rulePin, run]);

  const handleRemove = useCallback(async () => {
    const orgName = overview?.status?.orgName ?? "this workspace";
    const confirmed = await confirmDialog({
      title: `Remove the ${BRAND.NAME} agent?`,
      message: `Delegations to ${BRAND.NAME} stop for everyone in ${orgName}. Lanes and chats it started stay in ${BRAND.NAME}.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (confirmed) await run("uninstall", () => ctoApi().uninstallLinearAgent(requirePin(pin)));
  }, [overview?.status?.orgName, pin, run]);

  // The last overview outlives a disconnect; while disconnected it says nothing.
  const live = connected ? overview : null;
  const status = live?.status ?? null;
  const installed = status?.installed === true;
  // Linear lets only workspace admins add the agent; unknown (null) keeps Add.
  const needsAdmin = connected && !installed && viewerIsAdmin === false;
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
      title={`${BRAND.NAME} agent`}
      hint={`Your team assigns Linear issues to ${BRAND.NAME}, or mentions @${BRAND.NAME} in a comment. Each one runs on the ${BRAND.NAME} of the person who asked.`}
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
            title: `Can't reach the ${BRAND.NAME} agent service`,
            detail: `${overview?.message ?? "No answer from the relay."} Sign in to ${BRAND.NAME} in Settings › Account.`,
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
            title: `Issues you assign to ${BRAND.NAME} go to another ${BRAND.NAME} account`,
            detail: `Linear sends them to a different ${BRAND.NAME} sign-in. Route them here to run them on this account's machines.`,
            actions: [{
              label: busy === "member" ? "Routing…" : "Route to this account",
              variant: "secondary",
              onClick: () => void run("member", () => ctoApi().registerLinearAgentMember({ replace: true }, requirePin(pin))),
            }],
          }}
        />
      ) : null}

      <ol className="ade-ig-steps">
        <li className="ade-ig-step" data-done={installed ? "true" : undefined} data-waiting={!connected ? "true" : undefined}>
          <span className="ade-ig-step-num" aria-hidden>{installed ? <Check size={11} weight="bold" /> : 1}</span>
          <div className="ade-ig-step-main">
            <div className="ade-ig-step-head">
              <b>Add {BRAND.NAME} to your workspace</b>
              {checking ? <CircleNotch size={12} className="animate-spin" style={{ color: "var(--color-muted-fg)" }} /> : null}
            </div>
            <p className="ade-ig-note">
              {!connected
                ? "Connect Linear first."
                : installed
                  ? `Added to ${status?.orgName ?? "this workspace"}.`
                  : needsAdmin
                    ? `Only an admin of your Linear workspace can add ${BRAND.NAME}, and you are not one. Once an admin adds it from their ${BRAND.NAME}, this step is done for you too.`
                    : `A workspace admin approves it once. After that, teammates only connect Linear in their own ${BRAND.NAME}.`}
            </p>
            {needsAdmin && status ? (
              <div className="ade-ig-step-actions" style={{ flexDirection: "column", alignItems: "flex-start" }}>
                <button type="button" className="ade-modern-btn" onClick={() => void copyNoteForAdmin(status.orgName ?? "this workspace")}>
                  <Copy size={12} />
                  Copy a note for an admin
                </button>
                {adminNote ? <p className="ade-ig-note" style={{ userSelect: "text" }} data-testid="linear-agent-admin-note">{adminNote}</p> : null}
              </div>
            ) : connected && !installed && status ? (
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
              <p className="ade-ig-note">{BRAND.NAME} won&rsquo;t pick one for you. Each assigned issue gets its own lane.</p>
            ) : rules.length === 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
                <div
                  style={{
                    display: "grid",
                    // The model gets its own row: a name like "Claude Opus 5.5"
                    // needs the width, and the card is half the page.
                    gridTemplateColumns: hasReasoning ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)",
                    gap: 10,
                    alignItems: "start",
                  }}
                >
                  <Field label="Model" wide>
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
                    Also answer @{BRAND.NAME} mentions
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
            <div className="ade-ig-step-head"><b>Assign issues to {BRAND.NAME} in Linear</b></div>
            {installed && status && otherMembers.length > 0 ? (
              // One short line however many teammates use ADE; the names open
              // on demand instead of growing the step.
              <details className="ade-linear-link" data-linear-agent-members="">
                <summary className="ade-ig-note">
                  {otherMembers.length === 1 ? `1 other person uses ${BRAND.NAME}` : `${otherMembers.length} other people use ${BRAND.NAME}`} in this workspace. Their issues run on their own {BRAND.NAME}.{" "}
                  <CaretDown size={11} className="ade-linear-links-caret" aria-label="Show who" />
                </summary>
                <div className="ade-ig-chips">
                  {otherMembers.map((member, index) => (
                    <span key={member.linearUserId || `${member.displayName ?? "someone"}-${index}`} className="kit-tag">{member.displayName ?? "Someone"}</span>
                  ))}
                </div>
              </details>
            ) : (
              <p className="ade-ig-note">
                {installed && status
                  ? `You're the only one using ${BRAND.NAME} in this workspace so far.`
                  : `Or write @${BRAND.NAME} in a comment. ${BRAND.NAME} replies in Linear as it works.`}
              </p>
            )}
            {installed && status ? (
              <div className="ade-ig-inline-field">
                <span>When someone without {BRAND.NAME} assigns one</span>
                <select
                  className="ade-settings-input"
                  aria-label={`When someone who does not use ${BRAND.NAME} assigns an issue`}
                  style={{ height: 28, width: "auto", minWidth: 190 }}
                  disabled={!status.installedByMe || busy === "settings"}
                  value={status.fallbackMode}
                  title={status.installedByMe ? undefined : "Only the person who added the agent can change this."}
                  onChange={(event) => {
                    const mode = event.target.value === "runner" ? "runner" : "reply";
                    void run("settings", () => ctoApi().updateLinearAgentSettings({ fallbackMode: mode, runner: mode === "runner" ? "self" : null }, requirePin(pin)));
                  }}
                >
                  <option value="reply">Reply that they need {BRAND.NAME}</option>
                  <option value="runner">Run it on my {BRAND.NAME}</option>
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
