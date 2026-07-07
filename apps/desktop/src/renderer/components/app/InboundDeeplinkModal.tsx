import React from "react";
import { GitBranch, Warning } from "@phosphor-icons/react";

import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import type {
  AppNavigationTarget,
  CreateLaneFromPrBranchPreflightResult,
  LaneSummary,
} from "../../../shared/types";
import type { DeeplinkEnvelope } from "../../../shared/deeplinks";
import { openExternalUrl } from "../../lib/openExternal";
import { requestLinearIssueQuickView } from "../../lib/linearIssueQuickViewNavigation";

export type InboundBranchDeeplink = {
  repoOwner: string;
  repoName: string;
  branch: string;
  prNumber?: number | null;
};

export type InboundDeeplinkTarget =
  | ({ kind: "branch" } & InboundBranchDeeplink)
  | {
      kind: "foreign";
      entity: "chat" | "lane" | "commit";
      envelope: DeeplinkEnvelope | null;
      original: AppNavigationTarget;
    }
  | {
      kind: "switch-project";
      entity: "chat" | "lane" | "commit";
      project: { rootPath: string; displayName: string };
      original: AppNavigationTarget;
    };

export type InboundDeeplinkDispatchOptions = {
  suppressUnresolved?: boolean;
  forceLocal?: boolean;
};

export type InboundDeeplinkModalProps = {
  target: InboundDeeplinkTarget | InboundBranchDeeplink;
  onClose: () => void;
  onLaneOpened: (laneId: string) => void;
  onDispatchTarget?: (
    target: AppNavigationTarget,
    options?: InboundDeeplinkDispatchOptions,
  ) => Promise<boolean> | boolean;
  lanes: LaneSummary[];
  projectOpen?: boolean;
};

function formatActionError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function normalizeBranchForCompare(branch: string): string {
  const normalized = branch
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .trim();
  const parts = normalized.split("/");
  if (parts.length > 1 && ["origin", "upstream"].includes(parts[0] ?? "")) {
    return parts.slice(1).join("/");
  }
  return normalized;
}

function laneOwnedByBranch(lanes: LaneSummary[], branch: string): LaneSummary | null {
  const normalized = normalizeBranchForCompare(branch);
  return (
    lanes.find((lane) => normalizeBranchForCompare(lane.branchRef ?? "") === normalized) ?? null
  );
}

function displayBranchName(branch: string): string {
  return normalizeBranchForCompare(branch) || branch;
}

function normalizeInboundTarget(target: InboundDeeplinkTarget | InboundBranchDeeplink): InboundDeeplinkTarget {
  return "kind" in target ? target : { kind: "branch", ...target };
}

function originalTargetLabel(target: AppNavigationTarget, entity: "chat" | "lane" | "commit"): string {
  if ((target.kind === "work" || target.kind === "chat") && target.sessionId) return `Chat ${target.sessionId}`;
  if (target.kind === "lane") return "Lane";
  if (target.kind === "commit") return `Commit ${target.sha}`;
  return entity === "chat" ? "Chat" : entity === "commit" ? "Commit" : "Lane";
}

function targetEnvelope(target: AppNavigationTarget): DeeplinkEnvelope | null {
  if (
    (target.kind === "work"
      || target.kind === "chat"
      || target.kind === "lane"
      || target.kind === "commit"
      || target.kind === "artifact")
    && target.envelope
  ) {
    return target.envelope;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function InboundDeeplinkModal({
  target,
  onClose,
  onLaneOpened,
  onDispatchTarget,
  lanes,
  projectOpen = true,
}: InboundDeeplinkModalProps): React.ReactElement | null {
  const [currentTarget, setCurrentTarget] = React.useState<InboundDeeplinkTarget>(() => normalizeInboundTarget(target));
  const [preflight, setPreflight] = React.useState<CreateLaneFromPrBranchPreflightResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const branchTarget = currentTarget.kind === "branch" ? currentTarget : null;
  const isBranchOnly = branchTarget ? !branchTarget.prNumber : false;
  const laneImportAvailable = typeof window.ade?.lanes?.importBranch === "function";

  React.useEffect(() => {
    setCurrentTarget(normalizeInboundTarget(target));
    setPreflight(null);
    setLoading(false);
    setBusy(false);
    setError(null);
  }, [target]);

  const existingLane = React.useMemo(
    () => branchTarget ? laneOwnedByBranch(lanes, branchTarget.branch) : null,
    [branchTarget, lanes],
  );

  React.useEffect(() => {
    if (!branchTarget) return;
    if (existingLane) {
      onLaneOpened(existingLane.id);
      onClose();
    }
  }, [branchTarget, existingLane, onLaneOpened, onClose]);

  React.useEffect(() => {
    if (!branchTarget) return;
    if (existingLane) return;
    if (!projectOpen) {
      setPreflight(null);
      setError(`Open the ADE project for ${branchTarget.repoOwner}/${branchTarget.repoName} before creating a lane from this deeplink.`);
      setLoading(false);
      return;
    }
    if (isBranchOnly) {
      setPreflight(null);
      setError(laneImportAvailable ? null : "This ADE surface cannot create lanes from branch deeplinks.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    const prsApi = window.ade?.prs;
    if (!prsApi?.preflightCreateLaneFromPrBranch) {
      setError("Inbound deeplinks are not available in this build.");
      return;
    }
    setLoading(true);
    setError(null);
    setPreflight(null);
    void prsApi
      .preflightCreateLaneFromPrBranch({
        repoOwner: branchTarget.repoOwner,
        repoName: branchTarget.repoName,
        githubPrNumber: branchTarget.prNumber ?? undefined,
      })
      .then((result) => {
        if (!cancelled) setPreflight(result);
      })
      .catch((err) => {
        if (!cancelled) setError(formatActionError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branchTarget, existingLane, isBranchOnly, laneImportAvailable, projectOpen]);

  if (existingLane) return null;

  const renderFrame = (subtitle: string, body: React.ReactNode, footer: React.ReactNode): React.ReactElement => (
    <div
      role="presentation"
      style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.52)", backdropFilter: "blur(10px)", padding: 20 }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="inbound-deeplink-title" style={{ width: "min(560px, 100%)", borderRadius: 12, border: `1px solid ${COLORS.border}`, background: COLORS.cardBgSolid, boxShadow: "0 24px 80px rgba(0,0,0,0.45)", overflow: "hidden" }}>
        <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
          <div id="inbound-deeplink-title" style={{ fontFamily: SANS_FONT, fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>Open in ADE</div>
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>{subtitle}</div>
        </div>
        <div style={{ padding: 20, display: "grid", gap: 14 }}>
          {body}
          {error ? <div style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.5 }}>{error}</div> : null}
        </div>
        <div style={{ padding: "14px 20px", display: "flex", justifyContent: "flex-end", gap: 10, borderTop: `1px solid ${COLORS.border}` }}>
          {footer}
        </div>
      </div>
    </div>
  );

  if (!branchTarget) {
    if (currentTarget.kind === "switch-project") {
      const envelope = targetEnvelope(currentTarget.original);
      const repoLabel = envelope?.repoOwner && envelope.repoName ? `${envelope.repoOwner}/${envelope.repoName}` : null;
      const rows: Array<readonly [string, string]> = [
        ["Project", currentTarget.project.displayName],
        ...(repoLabel ? [["Repo", repoLabel] as const] : []),
        ["Opens", originalTargetLabel(currentTarget.original, currentTarget.entity)],
      ];
      const onSwitchProject = async () => {
        const switchToPath = window.ade?.project?.switchToPath;
        if (!switchToPath || !onDispatchTarget) {
          setError("Project switching is not available in this build.");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await switchToPath(currentTarget.project.rootPath);
        } catch (err) {
          setError(formatActionError(err));
          setBusy(false);
          return;
        }
        onClose();
        void (async () => {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            if (attempt > 0) await sleep(500);
            const handled = await onDispatchTarget(currentTarget.original, {
              suppressUnresolved: attempt < 4,
              forceLocal: attempt === 4,
            });
            if (handled) return;
          }
        })().catch(() => undefined);
      };

      return renderFrame(
        "This link belongs to another ADE project on this machine.",
        <div style={{ display: "grid", gap: 10 }}>
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: 12, alignItems: "baseline" }}>
              <div style={LABEL_STYLE}>{label}</div>
              <div style={{ fontFamily: label === "Project" || label === "Opens" ? SANS_FONT : MONO_FONT, fontSize: 12, color: COLORS.textSecondary, minWidth: 0, overflowWrap: "anywhere" }}>{value}</div>
            </div>
          ))}
        </div>,
        <>
          <button type="button" onClick={onClose} disabled={busy} style={outlineButton({ height: 34, opacity: busy ? 0.6 : 1 })}>Cancel</button>
          <button type="button" onClick={() => void onSwitchProject()} disabled={busy} style={primaryButton({ height: 34, opacity: busy ? 0.6 : 1 })}>{busy ? "Switching..." : "Switch project and open"}</button>
        </>,
      );
    }

    if (currentTarget.kind !== "foreign") return null;
    const envelope = currentTarget.envelope;
    const repoLabel = envelope?.repoOwner && envelope.repoName ? `${envelope.repoOwner}/${envelope.repoName}` : null;
    const headline = repoLabel
      ? `This ${currentTarget.entity} lives in ${repoLabel} on another machine.`
      : `This ${currentTarget.entity} lives on another machine.`;
    const hasRepo = Boolean(envelope?.repoOwner && envelope.repoName);
    const actions: React.ReactNode[] = [];
    if (hasRepo && envelope?.branch) {
      actions.push(
        <button
          key="branch"
          type="button"
          onClick={() => {
            setError(null);
            setPreflight(null);
            setCurrentTarget({
              kind: "branch",
              repoOwner: envelope.repoOwner!,
              repoName: envelope.repoName!,
              branch: envelope.branch!,
              prNumber: envelope.prNumber ?? null,
            });
          }}
          style={outlineButton({ height: 36 })}
        >
          <GitBranch size={14} /> Create lane from {envelope.branch}
        </button>,
      );
    }
    if (hasRepo && envelope?.prNumber != null) {
      actions.push(
        <button
          key="pr"
          type="button"
          onClick={() => {
            const owner = encodeURIComponent(envelope.repoOwner!);
            const repo = encodeURIComponent(envelope.repoName!);
            openExternalUrl(`https://github.com/${owner}/${repo}/pull/${envelope.prNumber}`);
            onClose();
          }}
          style={outlineButton({ height: 36 })}
        >
          Open PR #{envelope.prNumber} on GitHub
        </button>,
      );
    }
    if (hasRepo && currentTarget.original.kind === "commit") {
      const commitSha = currentTarget.original.sha;
      actions.push(
        <button
          key="commit"
          type="button"
          onClick={() => {
            const owner = encodeURIComponent(envelope!.repoOwner!);
            const repo = encodeURIComponent(envelope!.repoName!);
            openExternalUrl(`https://github.com/${owner}/${repo}/commit/${encodeURIComponent(commitSha)}`);
            onClose();
          }}
          style={outlineButton({ height: 36 })}
        >
          Open commit on GitHub
        </button>,
      );
    }
    if (envelope?.linearIssue) {
      actions.push(
        <button
          key="linear"
          type="button"
          onClick={() => {
            requestLinearIssueQuickView({ issueIdentifier: envelope.linearIssue!, source: "deeplink" });
            onClose();
          }}
          style={outlineButton({ height: 36 })}
        >
          Open Linear issue {envelope.linearIssue}
        </button>,
      );
    }

    return renderFrame(
      repoLabel ? "This link points at a machine-local ADE id." : "This link does not resolve on this machine.",
      <>
        <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textPrimary, lineHeight: 1.5 }}>{headline}</div>
        {!repoLabel ? <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.5 }}>The link did not carry anything this machine can open.</div> : null}
        {actions.length > 0 ? <div style={{ display: "grid", gap: 8 }}>{actions}</div> : null}
      </>,
      <button type="button" onClick={onClose} style={outlineButton({ height: 34 })}>Close</button>,
    );
  }

  const blocking = preflight?.preflight.blockingConflict?.message ?? null;
  const canConfirm = isBranchOnly
    ? projectOpen && !loading && !busy && laneImportAvailable
    : projectOpen && Boolean(preflight?.preflight.canCreate) && !loading && !busy && !error;

  const rows: Array<readonly [string, string]> = [];
  if (preflight?.preflight) {
    const p = preflight.preflight;
    rows.push(["Repo", `${p.repoOwner}/${p.repoName}`]);
    if (p.headBranch) rows.push(["Branch", p.baseBranch ? `${p.headBranch} -> ${p.baseBranch}` : p.headBranch]);
    rows.push(["PR", `#${p.githubPrNumber}  ${p.title}`.trim()]);
    rows.push(["Target lane", p.targetLaneName]);
  } else {
    rows.push(["Repo", `${branchTarget.repoOwner}/${branchTarget.repoName}`]);
    rows.push(["Branch", branchTarget.branch]);
    if (branchTarget.prNumber) rows.push(["PR", `#${branchTarget.prNumber}`]);
    else rows.push(["Action", "Fetch remote branch and create a local lane"]);
  }

  const onConfirm = async () => {
    setBusy(true);
    setError(null);
    if (isBranchOnly) {
      const lanesApi = window.ade?.lanes;
      if (!lanesApi?.importBranch) {
        setError("This ADE surface cannot create lanes from branch deeplinks.");
        setBusy(false);
        return;
      }
      try {
        const branch = branchTarget.branch.trim();
        const lane = await lanesApi.importBranch({ branchRef: branch, name: displayBranchName(branch) });
        if (lane.id) onLaneOpened(lane.id);
        onClose();
      } catch (err) {
        setError(formatActionError(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!branchTarget.prNumber) return;
    const prsApi = window.ade?.prs;
    if (!prsApi?.createLaneFromPrBranch) {
      setError("Inbound deeplinks are not available in this build.");
      setBusy(false);
      return;
    }
    try {
      const result = await prsApi.createLaneFromPrBranch({
        repoOwner: branchTarget.repoOwner,
        repoName: branchTarget.repoName,
        githubPrNumber: branchTarget.prNumber,
      });
      if (result.lane?.id) onLaneOpened(result.lane.id);
      onClose();
    } catch (err) {
      setError(formatActionError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="presentation"
      style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.52)", backdropFilter: "blur(10px)", padding: 20 }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="inbound-deeplink-title" style={{ width: "min(560px, 100%)", borderRadius: 12, border: `1px solid ${COLORS.border}`, background: COLORS.cardBgSolid, boxShadow: "0 24px 80px rgba(0,0,0,0.45)", overflow: "hidden" }}>
        <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
          <div id="inbound-deeplink-title" style={{ fontFamily: SANS_FONT, fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>Open in ADE</div>
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>
            {isBranchOnly ? "A branch was shared with you. ADE can fetch it and create the lane locally." : "A branch was shared with you. Create a lane to start working on it locally."}
          </div>
        </div>
        <div style={{ padding: 20, display: "grid", gap: 14 }}>
          {loading ? (
            <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textSecondary }}>
              {isBranchOnly ? "Preparing branch import..." : "Checking branch ownership and remote availability..."}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {rows.map(([label, value]) => (
                <div key={label} style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: 12, alignItems: "baseline" }}>
                  <div style={LABEL_STYLE}>{label}</div>
                  <div style={{ fontFamily: label === "PR" ? SANS_FONT : MONO_FONT, fontSize: 12, color: COLORS.textSecondary, minWidth: 0, overflowWrap: "anywhere" }}>{value}</div>
                </div>
              ))}
            </div>
          )}
          {blocking ? (
            <div style={{ display: "flex", gap: 10, padding: "10px 12px", borderRadius: 9, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.18)", color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.5 }}>
              <Warning size={15} weight="fill" style={{ marginTop: 2, flexShrink: 0 }} />
              <span>{blocking}</span>
            </div>
          ) : null}
          {error ? <div style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.5 }}>{error}</div> : null}
        </div>
        <div style={{ padding: "14px 20px", display: "flex", justifyContent: "flex-end", gap: 10, borderTop: `1px solid ${COLORS.border}` }}>
          <button type="button" onClick={onClose} disabled={busy} style={outlineButton({ height: 34, opacity: busy ? 0.6 : 1 })}>Cancel</button>
          <button type="button" onClick={() => void onConfirm()} disabled={!canConfirm} style={primaryButton({ height: 34, opacity: canConfirm ? 1 : 0.5 })}>
            <GitBranch size={14} /> {busy ? "Creating..." : isBranchOnly ? "Create lane from branch" : "Create lane"}
          </button>
        </div>
      </div>
    </div>
  );
}
