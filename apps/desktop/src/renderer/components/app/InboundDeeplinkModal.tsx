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
};

function formatActionError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function laneOwnedByBranch(lanes: LaneSummary[], branch: string): LaneSummary | null {
  const normalized = branch.replace(/^refs\/heads\//, "");
  return (
    lanes.find((lane) => {
      const ref = lane.branchRef ?? "";
      const laneBranch = ref.replace(/^refs\/heads\//, "");
      return laneBranch === normalized;
    }) ?? null
  );
}

export function InboundDeeplinkModal({
  target,
  onClose,
  onLaneOpened,
  lanes,
}: InboundDeeplinkModalProps): React.ReactElement | null {
  const [preflight, setPreflight] = React.useState<CreateLaneFromPrBranchPreflightResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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
    if (!target.prNumber) {
      // Branch-only deeplinks without a PR number aren't supported by the
      // existing preflight (which is PR-centric). Surface a clear message
      // so the receiver knows what to do.
      setError(
        "This deeplink references a branch without an associated PR. Open the PR in GitHub first, or share the PR deeplink instead.",
      );
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
        githubPrNumber: target.prNumber,
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
  }, [existingLane, target.repoOwner, target.repoName, target.prNumber]);

  if (existingLane) return null;

  const blocking = preflight?.preflight.blockingConflict?.message ?? null;
  const canConfirm =
    Boolean(preflight?.preflight.canCreate) && !loading && !busy && !error;

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
    if (target.prNumber) rows.push(["PR", `#${target.prNumber}`]);
  }

  const onConfirm = async () => {
    if (!target.prNumber) return;
    setBusy(true);
    setError(null);
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
            A branch was shared with you. Create a lane to start working on it locally.
          </div>
        </div>
        <div style={{ padding: 20, display: "grid", gap: 14 }}>
          {loading ? (
            <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textSecondary }}>
              Checking branch ownership and remote availability...
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
            <GitBranch size={14} /> {busy ? "Creating..." : "Create lane"}
          </button>
        </div>
      </div>
    </div>
  );
}
