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
  CreateLaneFromPrBranchPreflightResult,
  LaneSummary,
} from "../../../shared/types";

export type InboundBranchDeeplink = {
  repoOwner: string;
  repoName: string;
  branch: string;
  prNumber?: number | null;
};

export type InboundDeeplinkModalProps = {
  target: InboundBranchDeeplink;
  onClose: () => void;
  onLaneOpened: (laneId: string) => void;
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
    lanes.find((lane) => {
      const ref = lane.branchRef ?? "";
      const laneBranch = normalizeBranchForCompare(ref);
      return laneBranch === normalized;
    }) ?? null
  );
}

function displayBranchName(branch: string): string {
  return normalizeBranchForCompare(branch) || branch;
}

export function InboundDeeplinkModal({
  target,
  onClose,
  onLaneOpened,
  lanes,
  projectOpen = true,
}: InboundDeeplinkModalProps): React.ReactElement | null {
  const [preflight, setPreflight] = React.useState<CreateLaneFromPrBranchPreflightResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const isBranchOnly = !target.prNumber;
  const laneImportAvailable = typeof window.ade?.lanes?.importBranch === "function";

  const existingLane = React.useMemo(
    () => laneOwnedByBranch(lanes, target.branch),
    [lanes, target.branch],
  );

  React.useEffect(() => {
    // If a lane already exists for this branch, jump straight to it — no modal.
    if (existingLane) {
      onLaneOpened(existingLane.id);
      onClose();
    }
  }, [existingLane, onLaneOpened, onClose]);

  React.useEffect(() => {
    if (existingLane) return;
    if (!projectOpen) {
      setPreflight(null);
      setError(`Open the ADE project for ${target.repoOwner}/${target.repoName} before creating a lane from this deeplink.`);
      setLoading(false);
      return;
    }
    if (isBranchOnly) {
      setPreflight(null);
      setError(laneImportAvailable
        ? null
        : "This ADE surface cannot create lanes from branch deeplinks.");
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
        repoOwner: target.repoOwner,
        repoName: target.repoName,
        githubPrNumber: target.prNumber ?? undefined,
      })
      .then((result) => {
        if (cancelled) return;
        setPreflight(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(formatActionError(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [existingLane, isBranchOnly, laneImportAvailable, projectOpen, target.repoOwner, target.repoName, target.prNumber]);

  if (existingLane) return null;

  const blocking = preflight?.preflight.blockingConflict?.message ?? null;
  const canConfirm =
    isBranchOnly
      ? projectOpen && !loading && !busy && laneImportAvailable
      : projectOpen && Boolean(preflight?.preflight.canCreate) && !loading && !busy && !error;

  const rows: Array<readonly [string, string]> = [];
  if (preflight?.preflight) {
    const p = preflight.preflight;
    rows.push(["Repo", `${p.repoOwner}/${p.repoName}`]);
    if (p.headBranch) {
      rows.push(["Branch", p.baseBranch ? `${p.headBranch} → ${p.baseBranch}` : p.headBranch]);
    }
    rows.push(["PR", `#${p.githubPrNumber}  ${p.title}`.trim()]);
    rows.push(["Target lane", p.targetLaneName]);
  } else {
    rows.push(["Repo", `${target.repoOwner}/${target.repoName}`]);
    rows.push(["Branch", target.branch]);
    if (target.prNumber) {
      rows.push(["PR", `#${target.prNumber}`]);
    } else {
      rows.push(["Action", "Fetch remote branch and create a local lane"]);
    }
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
        const branch = target.branch.trim();
        const lane = await lanesApi.importBranch({
          branchRef: branch,
          name: displayBranchName(branch),
        });
        if (lane.id) onLaneOpened(lane.id);
        onClose();
      } catch (err) {
        setError(formatActionError(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!target.prNumber) return;
    const prsApi = window.ade?.prs;
    if (!prsApi?.createLaneFromPrBranch) {
      setError("Inbound deeplinks are not available in this build.");
      setBusy(false);
      return;
    }
    try {
      const result = await prsApi.createLaneFromPrBranch({
        repoOwner: target.repoOwner,
        repoName: target.repoName,
        githubPrNumber: target.prNumber,
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
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.52)",
        backdropFilter: "blur(10px)",
        padding: 20,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="inbound-deeplink-title"
        style={{
          width: "min(560px, 100%)",
          borderRadius: 12,
          border: `1px solid ${COLORS.border}`,
          background: COLORS.cardBgSolid,
          boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
          <div
            id="inbound-deeplink-title"
            style={{ fontFamily: SANS_FONT, fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}
          >
            Open in ADE
          </div>
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>
            {isBranchOnly
              ? "A branch was shared with you. ADE can fetch it and create the lane locally."
              : "A branch was shared with you. Create a lane to start working on it locally."}
          </div>
        </div>
        <div style={{ padding: 20, display: "grid", gap: 14 }}>
          {loading ? (
            <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textSecondary }}>
              {isBranchOnly
                ? "Preparing branch import..."
                : "Checking branch ownership and remote availability..."}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {rows.map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "120px minmax(0, 1fr)",
                    gap: 12,
                    alignItems: "baseline",
                  }}
                >
                  <div style={LABEL_STYLE}>{label}</div>
                  <div
                    style={{
                      fontFamily: label === "PR" ? SANS_FONT : MONO_FONT,
                      fontSize: 12,
                      color: COLORS.textSecondary,
                      minWidth: 0,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {value}
                  </div>
                </div>
              ))}
            </div>
          )}
          {blocking ? (
            <div
              style={{
                display: "flex",
                gap: 10,
                padding: "10px 12px",
                borderRadius: 9,
                background: "rgba(239,68,68,0.08)",
                border: "1px solid rgba(239,68,68,0.18)",
                color: COLORS.danger,
                fontFamily: SANS_FONT,
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              <Warning size={15} weight="fill" style={{ marginTop: 2, flexShrink: 0 }} />
              <span>{blocking}</span>
            </div>
          ) : null}
          {error ? (
            <div
              style={{
                color: COLORS.danger,
                fontFamily: SANS_FONT,
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          ) : null}
        </div>
        <div
          style={{
            padding: "14px 20px",
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            borderTop: `1px solid ${COLORS.border}`,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={outlineButton({ height: 34, opacity: busy ? 0.6 : 1 })}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={!canConfirm}
            style={primaryButton({ height: 34, opacity: canConfirm ? 1 : 0.5 })}
          >
            <GitBranch size={14} /> {busy ? "Creating..." : isBranchOnly ? "Create lane from branch" : "Create lane"}
          </button>
        </div>
      </div>
    </div>
  );
}
