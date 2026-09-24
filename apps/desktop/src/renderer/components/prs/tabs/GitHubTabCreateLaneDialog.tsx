import { GitBranch, Warning } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type {
  CreateLaneFromPrBranchArgs,
  CreateLaneFromPrBranchPreflight,
  CreateLaneFromPrBranchPreflightResult,
  CreateLaneFromPrBranchResult,
  GitHubPrListItem,
  GitHubPrSnapshot,
  LaneSummary,
} from "../../../../shared/types";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
} from "../../lanes/laneDesignTokens";
import { Dialog } from "../../ui/dialog";
import { branchNameFromRef } from "./githubPrBranch";
import { prRouteCoordinatesEqual, prRouteCoordinatesKey } from "../prsRouteState";

type CreateLaneFromPrBranchApi = {
  preflightCreateLaneFromPrBranch: (
    args: CreateLaneFromPrBranchArgs,
  ) => Promise<CreateLaneFromPrBranchPreflightResult>;
  createLaneFromPrBranch: (
    args: CreateLaneFromPrBranchArgs,
  ) => Promise<CreateLaneFromPrBranchResult>;
};

export function formatActionError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim() || "Action failed.";
}

export function createLaneFromPrBranchApi(): CreateLaneFromPrBranchApi {
  return window.ade.prs as typeof window.ade.prs & CreateLaneFromPrBranchApi;
}

export function createLaneFromPrBranchArgs(
  item: GitHubPrListItem,
  laneName?: string | null,
): CreateLaneFromPrBranchArgs {
  const trimmedName = laneName?.trim();
  return {
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    githubPrNumber: item.githubPrNumber,
    ...(trimmedName ? { laneName: trimmedName } : {}),
  };
}

export function createLaneFromPrBranchRequestKey(item: GitHubPrListItem): string {
  return prRouteCoordinatesKey({
    prNumber: Number(item.githubPrNumber),
    repoOwner: item.repoOwner,
    repoName: item.repoName,
  });
}

function preflightText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = preflightText(record.message) ?? preflightText(record.reason) ?? preflightText(record.summary);
    if (message) return message;
    try {
      return JSON.stringify(value);
    } catch {
      return "Conflict details unavailable.";
    }
  }
  return String(value);
}

function preflightPrNumber(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): number {
  return Number(preflight?.githubPrNumber ?? item.githubPrNumber);
}

function preflightTitle(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): string {
  return preflightText(preflight?.title) ?? item.title;
}

function preflightRemoteBranch(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): string {
  return preflightText(preflight?.remoteBranch) ?? preflightText(preflight?.headBranch) ?? item.headBranch ?? "---";
}

function preflightImportRef(preflight: CreateLaneFromPrBranchPreflight | null): string | null {
  return preflightText(preflight?.importBranchRef);
}

function preflightTargetLaneName(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): string {
  const remoteBranch = preflightRemoteBranch(preflight, item);
  const fallback = branchNameFromRef(remoteBranch);
  return preflightText(preflight?.targetLaneName) ?? (fallback || "New lane");
}

function preflightBaseBranch(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): string {
  return preflightText(preflight?.baseBranch) ?? item.baseBranch ?? "---";
}

function preflightBlockingConflict(preflight: CreateLaneFromPrBranchPreflight | null): string | null {
  return preflightText(preflight?.blockingConflict);
}

export function createLaneMappedPrId(result: CreateLaneFromPrBranchResult): string | null {
  return preflightText(result.pr?.id);
}

export function createLaneMappedLaneId(result: CreateLaneFromPrBranchResult): string | null {
  return preflightText(result.pr?.laneId) ?? preflightText(result.lane?.id);
}

export function createLaneMappedLaneName(result: CreateLaneFromPrBranchResult): string | null {
  return preflightText(result.lane?.name);
}

export function upsertLaneSummary(lanes: LaneSummary[], lane: LaneSummary): LaneSummary[] {
  const index = lanes.findIndex((entry) => entry.id === lane.id);
  if (index === -1) return [lane, ...lanes];
  const next = lanes.slice();
  next[index] = lane;
  return next;
}

export function canCreateLaneFromPrBranch(item: GitHubPrListItem, lanes: LaneSummary[]): boolean {
  if (item.linkedPrId || item.scope !== "repo") return false;
  if (item.state !== "open" && item.state !== "draft") return false;
  const headBranch = branchNameFromRef(item.headBranch);
  if (!headBranch) return false;
  return !lanes.some((lane) => !lane.archivedAt && branchNameFromRef(lane.branchRef) === headBranch);
}

function sameGitHubPr(left: GitHubPrListItem, right: GitHubPrListItem): boolean {
  return prRouteCoordinatesEqual(
    {
      prNumber: Number(left.githubPrNumber),
      repoOwner: left.repoOwner,
      repoName: left.repoName,
    },
    {
      prNumber: Number(right.githubPrNumber),
      repoOwner: right.repoOwner,
      repoName: right.repoName,
    },
  );
}

export function patchSnapshotWithMappedPr(
  snapshot: GitHubPrSnapshot,
  item: GitHubPrListItem,
  args: {
    mappedPrId: string;
    laneId: string | null;
    laneName: string | null;
  },
): GitHubPrSnapshot {
  const patchItems = (items: GitHubPrListItem[]) => items.map((candidate) => {
    if (candidate.id !== item.id && !sameGitHubPr(candidate, item)) return candidate;
    return {
      ...candidate,
      linkedPrId: args.mappedPrId,
      linkedLaneId: args.laneId ?? candidate.linkedLaneId,
      linkedLaneName: args.laneName ?? candidate.linkedLaneName,
      adeKind: candidate.adeKind ?? "single",
    };
  });
  return {
    ...snapshot,
    repoPullRequests: patchItems(snapshot.repoPullRequests),
    externalPullRequests: patchItems(snapshot.externalPullRequests),
  };
}

export function CreateLaneFromPrBranchDialog({
  item,
  preflight,
  loading,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  item: GitHubPrListItem;
  preflight: CreateLaneFromPrBranchPreflight | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  /** Receives the (possibly edited) lane name the user wants to create. */
  onConfirm: (laneName: string) => void;
}) {
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const requestKey = createLaneFromPrBranchRequestKey(item);
  const [laneName, setLaneName] = useState("");
  const seededRequestRef = useRef<string | null>(null);

  // Seed the field with the server's suggested name once per PR (and after the
  // preflight lands). Editing is sticky: a later render must not clobber what
  // the user typed.
  useEffect(() => {
    if (loading) return;
    if (seededRequestRef.current === requestKey) return;
    seededRequestRef.current = requestKey;
    setLaneName(preflightTargetLaneName(preflight, item));
  }, [item, loading, preflight, requestKey]);

  const blockingConflict = preflightBlockingConflict(preflight);
  const canConfirm = Boolean(preflight?.canCreate) && !loading && !busy && laneName.trim().length > 0;
  const sourceBranch = preflightRemoteBranch(preflight, item);
  const importRef = preflightImportRef(preflight);
  const rows = [
    ["PR", `#${preflightPrNumber(preflight, item)} ${preflightTitle(preflight, item)}`],
    ["Source branch", sourceBranch],
    ...(importRef && importRef !== sourceBranch ? [["Import ref", importRef] as const] : []),
    ["Base branch", preflightBaseBranch(preflight, item)],
  ] as const;

  const handleSubmit = () => {
    const trimmed = laneName.trim();
    if (!canConfirm || !trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !busy) onCancel(); }}
      title="Create lane from PR branch"
      description="Check this pull request's branch out into a local lane. Give the lane a name you'll recognize in the Lanes tab."
      size="md"
      dismissible={!busy}
      onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
      initialFocusRef={nameInputRef}
      testId="create-lane-from-pr-dialog"
      actions={[
        { label: "Cancel", variant: "secondary", onClick: onCancel, disabled: busy },
        {
          label: busy ? "Creating…" : "Create lane",
          variant: "solid",
          icon: <GitBranch size={14} />,
          busy,
          disabled: !canConfirm,
          onClick: handleSubmit,
        },
      ]}
    >
      <div style={{ display: "grid", gap: 14 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={LABEL_STYLE}>Lane name</span>
          <input
            ref={nameInputRef}
            type="text"
            value={laneName}
            disabled={loading || busy}
            aria-label="Lane name"
            placeholder="New lane"
            onChange={(event) => setLaneName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleSubmit();
              }
            }}
            style={{
              height: 34,
              padding: "0 10px",
              borderRadius: 8,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.recessedBg,
              color: COLORS.textPrimary,
              fontFamily: SANS_FONT,
              fontSize: 12.5,
              outline: "none",
              opacity: loading || busy ? 0.6 : 1,
            }}
          />
        </label>
        {loading ? (
          <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textSecondary }}>
            Checking branch ownership and PR head availability...
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {rows.map(([label, value]) => (
              <div key={label} style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: 12, alignItems: "baseline" }}>
                <div style={LABEL_STYLE}>{label}</div>
                <div style={{ fontFamily: label === "PR" ? SANS_FONT : MONO_FONT, fontSize: 12, color: COLORS.textSecondary, minWidth: 0, overflowWrap: "anywhere" }}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        )}
        {blockingConflict ? (
          <div style={{
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
          }}>
            <Warning size={15} weight="fill" style={{ marginTop: 2, flexShrink: 0 }} />
            <span>{blockingConflict}</span>
          </div>
        ) : null}
        {error ? (
          <div style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.5 }}>
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
