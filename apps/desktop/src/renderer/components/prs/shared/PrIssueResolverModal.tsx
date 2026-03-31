import React from "react";
import { CheckCircle, ChatText, CopySimple, Play, Warning, X } from "@phosphor-icons/react";
import type { AiPermissionMode, PrCheck, PrIssueResolutionScope, PrReviewThread } from "../../../../shared/types";
import type { PrIssueResolutionAvailability } from "../../../../shared/prIssueResolution";
import { defaultPrIssueResolutionScope } from "../../../../shared/prIssueResolution";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { PrResolverLaunchControls } from "./PrResolverLaunchControls";

type PrIssueResolverModalProps = {
  open: boolean;
  prNumber: number;
  prTitle: string;
  availability: PrIssueResolutionAvailability;
  checks: PrCheck[];
  reviewThreads: PrReviewThread[];
  modelId: string;
  reasoningEffort: string;
  permissionMode: AiPermissionMode;
  busy: boolean;
  copyBusy: boolean;
  copyNotice: string | null;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionModeChange: (mode: AiPermissionMode) => void;
  onLaunch: (args: { scope: PrIssueResolutionScope; additionalInstructions: string }) => Promise<void>;
  onCopyPrompt: (args: { scope: PrIssueResolutionScope; additionalInstructions: string }) => Promise<void>;
};

function isScopeSelectable(scope: PrIssueResolutionScope, availability: PrIssueResolutionAvailability): boolean {
  if (scope === "both") return availability.hasActionableChecks && availability.hasActionableComments;
  if (scope === "comments") return availability.hasActionableComments;
  return availability.hasActionableChecks;
}

function truncateText(value: string | null | undefined, max = 150): string {
  const normalized = (value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "(no comment body)";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function extractSeverity(value: string | null | undefined): string | null {
  const match = (value ?? "").match(/\b(Critical|Major|Minor)\b/i);
  return match?.[1] ? match[1][0].toUpperCase() + match[1].slice(1).toLowerCase() : null;
}

function extractThreadHeadline(value: string | null | undefined): string {
  const raw = value ?? "";
  const titleMatch = raw.match(/\*\*([^*]+)\*\*/);
  if (titleMatch?.[1]) return truncateText(titleMatch[1], 120);
  return truncateText(
    raw
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<details>[\s\S]*?<\/details>/gi, " ")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[_*#>|]/g, " ")
      .replace(/\s+/g, " "),
    120,
  );
}

function formatThreadLocation(thread: PrReviewThread): string {
  const path = thread.path ?? "unknown location";
  if (thread.line != null) return `${path}:${thread.line}`;
  return path;
}

function issueCountLabel(scope: PrIssueResolutionScope, availability: PrIssueResolutionAvailability): string {
  if (scope === "both") {
    return `${availability.failingCheckCount + availability.actionableReviewThreadCount} items`;
  }
  if (scope === "comments") {
    return `${availability.actionableReviewThreadCount} threads`;
  }
  return `${availability.failingCheckCount} checks`;
}

const panelStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 16,
  background: `linear-gradient(180deg, ${COLORS.recessedBg} 0%, rgba(255,255,255,0.015) 100%)`,
};

export function PrIssueResolverModal({
  open,
  prNumber,
  prTitle,
  availability,
  checks,
  reviewThreads,
  modelId,
  reasoningEffort,
  permissionMode,
  busy,
  copyBusy,
  copyNotice,
  error,
  onOpenChange,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
  onLaunch,
  onCopyPrompt,
}: PrIssueResolverModalProps) {
  const [scope, setScope] = React.useState<PrIssueResolutionScope>("checks");
  const [additionalInstructions, setAdditionalInstructions] = React.useState("");
  const previouslyOpenRef = React.useRef(false);
  const dialogScrollRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (open && !previouslyOpenRef.current) {
      const initialScope = defaultPrIssueResolutionScope(availability);
      if (initialScope) setScope(initialScope);
      setAdditionalInstructions("");
    }
    previouslyOpenRef.current = open;
  }, [availability, open]);

  React.useEffect(() => {
    if (!open) return;
    const raf = window.requestAnimationFrame(() => {
      dialogScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    if (isScopeSelectable(scope, availability)) return;
    const nextScope = defaultPrIssueResolutionScope(availability);
    if (nextScope) setScope(nextScope);
  }, [availability, open, scope]);

  if (!open) return null;

  const actionableThreads = reviewThreads.filter((thread) => !thread.isResolved && !thread.isOutdated);
  const failingChecks = checks.filter((check) => check.conclusion === "failure");
  const canLaunch = isScopeSelectable(scope, availability) && !busy;
  const canCopy = isScopeSelectable(scope, availability) && !busy && !copyBusy;
  const modalLocked = busy || copyBusy;

  const scopeOptions: Array<{
    id: PrIssueResolutionScope;
    label: string;
    description: string;
    enabled: boolean;
    accent: string;
  }> = [
    {
      id: "both",
      label: "Checks + comments",
      description: "Use one agent run to clear CI failures and unresolved review threads together.",
      enabled: availability.hasActionableChecks && availability.hasActionableComments,
      accent: COLORS.accent,
    },
    {
      id: "checks",
      label: "Checks only",
      description: "Work the failing CI surface after checks have fully stopped running.",
      enabled: availability.hasActionableChecks,
      accent: COLORS.warning,
    },
    {
      id: "comments",
      label: "Comments only",
      description: "Address GitHub review threads, reply when useful, and resolve them after the fix lands.",
      enabled: availability.hasActionableComments,
      accent: COLORS.info,
    },
  ];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(3, 4, 10, 0.76)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        zIndex: 140,
        overflowY: "auto",
        padding: "40px 24px",
      }}
      onClick={() => { if (!modalLocked) onOpenChange(false); }}
    >
      <div
        ref={dialogScrollRef}
        role="dialog"
        aria-modal="true"
        aria-label="Resolve issues with agent"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(1040px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 80px)",
          overflow: "auto",
          margin: "0 auto",
          background: COLORS.cardBgSolid,
          border: `1px solid ${COLORS.outlineBorder}`,
          borderRadius: 22,
          boxShadow: "0 30px 100px rgba(0,0,0,0.55)",
        }}
      >
        <div style={{ position: "sticky", top: 0, zIndex: 2, padding: 22, borderBottom: `1px solid ${COLORS.border}`, background: "linear-gradient(180deg, rgba(24,20,35,0.98) 0%, rgba(24,20,35,0.96) 100%)", backdropFilter: "blur(12px)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20 }}>
            <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <div style={{ fontFamily: SANS_FONT, fontSize: 22, fontWeight: 700, color: COLORS.textPrimary, lineHeight: 1.1, letterSpacing: "-0.01em" }}>
                  Resolve issues with agent
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ padding: "5px 9px", borderRadius: 999, background: `${COLORS.accent}18`, color: COLORS.accent, fontFamily: MONO_FONT, fontSize: 11 }}>
                  PR #{prNumber}
                </span>
                <span style={{ padding: "5px 9px", borderRadius: 999, background: `${COLORS.warning}14`, color: COLORS.warning, fontFamily: MONO_FONT, fontSize: 11 }}>
                  {availability.failingCheckCount} failing checks
                </span>
                <span style={{ padding: "5px 9px", borderRadius: 999, background: `${COLORS.info}14`, color: COLORS.info, fontFamily: MONO_FONT, fontSize: 11 }}>
                  {availability.actionableReviewThreadCount} review threads
                </span>
                <span style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 420 }}>
                  {prTitle}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={modalLocked}
              style={{
                width: 36,
                height: 36,
                borderRadius: 999,
                border: `1px solid ${COLORS.border}`,
                background: COLORS.recessedBg,
                cursor: modalLocked ? "default" : "pointer",
                color: COLORS.textMuted,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ ...panelStyle, padding: 16 }}>
            <div style={{ ...LABEL_STYLE, marginBottom: 12 }}>Scope</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {scopeOptions.map((option) => {
                const active = scope === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={!option.enabled || modalLocked}
                    aria-pressed={active}
                    onClick={() => setScope(option.id)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 10,
                      minHeight: 80,
                      padding: "16px 16px 14px",
                      borderRadius: 16,
                      border: `1px solid ${active ? option.accent : COLORS.border}`,
                      background: active ? `${option.accent}14` : "rgba(255,255,255,0.02)",
                      color: option.enabled ? COLORS.textPrimary : COLORS.textDim,
                      cursor: option.enabled && !modalLocked ? "pointer" : "not-allowed",
                      opacity: option.enabled ? 1 : 0.45,
                      textAlign: "left",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, width: "100%" }}>
                      <span style={{ fontFamily: SANS_FONT, fontSize: 15, fontWeight: 700 }}>{option.label}</span>
                      <span style={{ padding: "4px 8px", borderRadius: 999, background: active ? `${option.accent}24` : "rgba(255,255,255,0.04)", color: active ? option.accent : COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 10 }}>
                        {issueCountLabel(option.id, availability)}
                      </span>
                    </div>
                    <span style={{ fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.6, color: active ? COLORS.textSecondary : COLORS.textMuted }}>
                      {option.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ ...panelStyle, padding: 16 }}>
            <div style={{ ...LABEL_STYLE, marginBottom: 10 }}>Launch settings</div>
            <PrResolverLaunchControls
              modelId={modelId}
              reasoningEffort={reasoningEffort}
              permissionMode={permissionMode}
              onModelChange={onModelChange}
              onReasoningEffortChange={onReasoningEffortChange}
              onPermissionModeChange={onPermissionModeChange}
              disabled={modalLocked}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <div style={{ ...panelStyle, padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <Play size={16} weight="fill" style={{ color: availability.hasActionableChecks ? COLORS.warning : COLORS.textDim }} />
                  <div>
                    <div style={{ fontFamily: SANS_FONT, fontSize: 15, fontWeight: 700, color: COLORS.textPrimary }}>Checks</div>
                    <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
                      {availability.hasActionableChecks
                        ? "These failures will be included in the resolver prompt."
                        : availability.pendingCheckCount > 0
                          ? "Checks are still running, so the checks scope stays disabled for now."
                          : "No actionable failing checks right now."}
                    </div>
                  </div>
                  <span style={{ marginLeft: "auto", padding: "4px 8px", borderRadius: 999, background: `${COLORS.warning}18`, color: availability.hasActionableChecks ? COLORS.warning : COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 10 }}>
                    {availability.hasActionableChecks ? `${availability.failingCheckCount} actionable` : availability.pendingCheckCount > 0 ? "running" : "none"}
                  </span>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 240, overflow: "auto", paddingRight: 4 }}>
                  {failingChecks.length > 0 ? failingChecks.map((check) => (
                    <div key={check.name} style={{ padding: "11px 12px", borderRadius: 12, border: `1px solid ${COLORS.border}`, background: "rgba(255,255,255,0.02)" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
                          {check.name}
                        </span>
                        <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.warning }}>
                          {check.conclusion ?? check.status}
                        </span>
                      </div>
                      {check.detailsUrl ? (
                        <div style={{ marginTop: 6, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {check.detailsUrl}
                        </div>
                      ) : null}
                    </div>
                  )) : (
                    <div style={{ padding: "14px 12px", borderRadius: 12, border: `1px dashed ${COLORS.border}`, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
                      {availability.pendingCheckCount > 0
                        ? "ADE will wait until the current CI run finishes before checks can become a selectable scope."
                        : "No failing checks are available to resolve right now."}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <div style={{ ...panelStyle, padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <ChatText size={16} weight="fill" style={{ color: availability.hasActionableComments ? COLORS.info : COLORS.textDim }} />
                  <div>
                    <div style={{ fontFamily: SANS_FONT, fontSize: 15, fontWeight: 700, color: COLORS.textPrimary }}>Review threads</div>
                    <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
                      Unresolved, non-outdated GitHub review threads that ADE will feed into the resolver prompt.
                    </div>
                  </div>
                  <span style={{ marginLeft: "auto", padding: "4px 8px", borderRadius: 999, background: `${COLORS.info}18`, color: availability.hasActionableComments ? COLORS.info : COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 10 }}>
                    {availability.actionableReviewThreadCount} actionable
                  </span>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 348, overflow: "auto", paddingRight: 4 }}>
                  {actionableThreads.length > 0 ? actionableThreads.map((thread) => {
                    const firstComment = thread.comments[0] ?? null;
                    const severity = extractSeverity(firstComment?.body);
                    const headline = extractThreadHeadline(firstComment?.body);
                    return (
                      <div key={thread.id} style={{ padding: "12px 12px 11px", borderRadius: 12, border: `1px solid ${COLORS.border}`, background: "rgba(255,255,255,0.02)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" }}>
                          <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                            {formatThreadLocation(thread)}
                          </span>
                          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.info, flexShrink: 0 }}>
                            {firstComment?.author ?? "unknown"}
                          </span>
                        </div>
                        <div style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          {severity ? (
                            <span style={{ padding: "3px 7px", borderRadius: 999, background: `${COLORS.info}18`, color: COLORS.info, fontFamily: MONO_FONT, fontSize: 10 }}>
                              {severity}
                            </span>
                          ) : null}
                          <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, lineHeight: 1.5 }}>
                            {headline}
                          </span>
                        </div>
                        <div style={{ marginTop: 6, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {thread.url ?? firstComment?.url ?? "No thread URL available"}
                        </div>
                      </div>
                    );
                  }) : (
                    <div style={{ padding: "14px 12px", borderRadius: 12, border: `1px dashed ${COLORS.border}`, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
                      No unresolved non-outdated review threads are currently actionable.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div style={{ ...panelStyle, padding: 16 }}>
            <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>Additional instructions</div>
            <textarea
              value={additionalInstructions}
              onChange={(event) => setAdditionalInstructions(event.target.value)}
              placeholder="Example: prefer small commits, keep the PR description updated, and rerun focused tests before broader suites."
              disabled={modalLocked}
              style={{
                width: "100%",
                minHeight: 72,
                resize: "vertical",
                padding: 14,
                borderRadius: 14,
                border: `1px solid ${COLORS.border}`,
                background: "rgba(255,255,255,0.02)",
                color: COLORS.textPrimary,
                fontFamily: SANS_FONT,
                fontSize: 13,
                lineHeight: 1.6,
                outline: "none",
              }}
            />
          </div>

          {error ? (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "13px 14px", borderRadius: 14, border: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}0D`, color: COLORS.danger }}>
              <Warning size={15} weight="fill" style={{ marginTop: 2, flexShrink: 0 }} />
              <span style={{ fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.6 }}>{error}</span>
            </div>
          ) : null}

          <div style={{ position: "sticky", bottom: 0, zIndex: 2, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", padding: "14px 0 2px", background: "linear-gradient(180deg, rgba(24,20,35,0) 0%, rgba(24,20,35,0.98) 34%, rgba(24,20,35,1) 100%)" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: COLORS.textMuted }}>
                <CheckCircle size={13} weight="fill" style={{ color: COLORS.success }} />
                <span style={{ fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.5 }}>
                  Launch uses the normal work-chat path, tools, and memory-aware prompt behavior.
                </span>
              </div>
              {copyNotice ? (
                <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.success }}>
                  {copyNotice}
                </div>
              ) : null}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
              <button
                type="button"
                disabled={!canCopy}
                onClick={() => void onCopyPrompt({ scope, additionalInstructions })}
                style={outlineButton({ height: 38, padding: "0 14px", color: COLORS.info, borderColor: `${COLORS.info}35`, opacity: canCopy ? 1 : 0.5 })}
              >
                <CopySimple size={14} />
                {copyBusy ? "Copying..." : "Copy prompt"}
              </button>
              <button type="button" onClick={() => onOpenChange(false)} disabled={modalLocked} style={outlineButton({ height: 38, padding: "0 14px" })}>
                Cancel
              </button>
              <button
                type="button"
                disabled={!canLaunch}
                onClick={() => void onLaunch({ scope, additionalInstructions })}
                style={primaryButton({ height: 38, padding: "0 18px", opacity: canLaunch ? 1 : 0.5 })}
              >
                {busy ? "Launching..." : "Launch agent"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
