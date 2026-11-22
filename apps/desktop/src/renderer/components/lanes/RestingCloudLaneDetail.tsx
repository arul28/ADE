import { useEffect, useState } from "react";
import { CircleNotch, GearSix, Lightning } from "@phosphor-icons/react";
import type { CloudGitSummaryCounts } from "../../../../../account-directory/src/cloud/contract";
import type { OpenProjectBinding } from "../../../shared/types/core";
import type { FileChange } from "../../../shared/types/git";
import { savedAgoLabel } from "../../lib/adeCloudAccountRead";
import {
  restingCloudMachineKey,
  useCloudMachineWakeInFlight,
  wakeRestingCloudMachine,
  type RestingCloudMachine,
} from "../../lib/cloudMachineWake";
import { useAdeCloudLaneWake } from "../../state/adeCloudLaneWake";
import { COLORS } from "./laneDesignTokens";

/** The most changed files the view lists; the rest is a count. */
const MAX_LISTED_FILES = 200;

type RestingLaneRow = RestingCloudMachine & {
  lane?: { id: string } | null;
  binding?: OpenProjectBinding | null;
};

type ReadState =
  | { status: "loading" }
  | { status: "ready"; summary: CloudGitSummaryCounts | null; files: FileChange[] | null }
  | { status: "failed"; message: string };

const KIND_LETTER: Record<FileChange["kind"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  unknown: "?",
};

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "ADE couldn't read this lane from your ADE account.";
}

/**
 * The lane's Git summary and changed files, as its computer last saved them.
 * Both come from the account: the overview has the "checked" time, and the
 * lane pin's change read is answered by the preload from the account while
 * the computer rests (`adeCloudRestingReads.ts`). One read when the lane
 * opens; no timer.
 */
function useRestingLaneRead(row: RestingLaneRow): ReadState {
  const laneId = row.lane?.id ?? null;
  const pin = row.binding ?? null;
  const origin = pin?.kind === "remote" ? pin.gitOriginUrl ?? null : null;
  const machineKey = restingCloudMachineKey(row);
  const pinKey = pin?.key ?? null;
  const [state, setState] = useState<ReadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const overviewFn = window.ade?.adeCloud?.projectOverview;
    const summaryRead: Promise<CloudGitSummaryCounts | null> = origin && laneId && typeof overviewFn === "function"
      ? overviewFn({ origin }).then((overview) =>
          overview?.git.find((entry) => entry.laneId === laneId && (!machineKey || entry.machineKey === machineKey))
          ?? overview?.git.find((entry) => entry.laneId === laneId)
          ?? null)
      : Promise.resolve(null);
    const filesRead: Promise<FileChange[] | null> = laneId && pin
      ? window.ade.diff.getChanges({ laneId }, pin).then((changes) => {
          // A file both staged and unstaged is one changed file: listed and counted once.
          const byPath = new Map<string, FileChange>();
          for (const file of [...changes.staged, ...changes.unstaged]) if (!byPath.has(file.path)) byPath.set(file.path, file);
          return [...byPath.values()];
        })
      : Promise.resolve(null);
    void Promise.allSettled([summaryRead, filesRead]).then(([summary, files]) => {
      if (cancelled) return;
      if (summary.status === "rejected" && files.status === "rejected") {
        setState({ status: "failed", message: messageOf(files.reason) });
        return;
      }
      setState({
        status: "ready",
        summary: summary.status === "fulfilled" ? summary.value : null,
        files: files.status === "fulfilled" ? files.value : null,
      });
    });
    return () => {
      cancelled = true;
    };
    // The pin's key names the lane's machine; a rebuilt pin with the same key reads nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId, pinKey, origin, machineKey]);

  return state;
}

/**
 * The opened lane of an ADE Cloud computer that is asleep. Reading never
 * wakes: the view shows what the account saved of the lane, and "Wake to
 * run" starts the computer. The lane opens in full once it is connected.
 */
export function RestingCloudLaneDetail({ laneName, machine, onManage }: {
  laneName: string;
  machine: RestingLaneRow;
  /** Size, free and delete: account actions that need no wake. */
  onManage?: () => void;
}) {
  const pin = machine.binding ?? null;
  const laneWake = useAdeCloudLaneWake(pin);
  const listWaking = useCloudMachineWakeInFlight(restingCloudMachineKey(machine));
  const waking = laneWake.state === "waking" || listWaking;
  const read = useRestingLaneRead(machine);
  const wake = () => {
    if (!laneWake.wake()) wakeRestingCloudMachine({ ...machine, machineName: "your ADE Cloud computer" });
  };

  const summary = read.status === "ready" ? read.summary : null;
  const files = read.status === "ready" ? read.files : null;
  const checked = summary ? savedAgoLabel(summary.checkedAt, "Checked") : null;
  const listed = files ? files.slice(0, MAX_LISTED_FILES) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="lane-detail-cloud-resting">
      <div
        className="flex shrink-0 items-start justify-between gap-3 px-4 py-3"
        style={{ borderBottom: `1px solid ${COLORS.borderMuted}` }}
      >
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium" style={{ color: COLORS.textPrimary }}>{laneName}</div>
          <div className="mt-0.5 text-[12px]" style={{ color: COLORS.textMuted }}>
            {waking
              ? "Waking your ADE Cloud computer. The lane opens when it is connected."
              : "Your ADE Cloud computer is asleep. This is the lane as it was last saved."}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onManage ? (
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-[12px] text-fg/85 hover:bg-fg/[0.05]"
              onClick={onManage}
              data-testid="lane-detail-cloud-manage"
            >
              <GearSix size={12} />
              Manage
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-[12px] text-fg/85 hover:bg-fg/[0.05] disabled:opacity-60"
            disabled={waking}
            onClick={wake}
            data-testid="lane-detail-cloud-wake"
          >
            {waking ? <CircleNotch size={12} className="animate-spin" /> : <Lightning size={12} />}
            {waking ? "Waking…" : "Wake to run"}
          </button>
        </div>
      </div>

      {laneWake.state === "failed" && laneWake.message ? (
        <div className="shrink-0 px-4 pt-2 text-[12px]" style={{ color: COLORS.danger }} role="alert">
          {laneWake.message}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {read.status === "loading" ? (
          <div className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: COLORS.textMuted }}>
            <CircleNotch size={12} className="animate-spin" />
            Reading the lane from your ADE account…
          </div>
        ) : read.status === "failed" ? (
          <div className="text-[12px]" style={{ color: COLORS.textMuted }}>{read.message}</div>
        ) : (
          <>
            {summary ? (
              <div className="mb-3 flex flex-col gap-0.5 text-[12px]" data-testid="lane-detail-cloud-git">
                <div style={{ color: COLORS.textPrimary }}>
                  {summary.branch ?? "No branch"}
                  {summary.upstream ? (
                    <span style={{ color: COLORS.textMuted }}>
                      {summary.ahead > 0 || summary.behind > 0
                        ? `, ${summary.ahead} ahead and ${summary.behind} behind ${summary.upstream}`
                        : `, up to date with ${summary.upstream}`}
                    </span>
                  ) : (
                    <span style={{ color: COLORS.textMuted }}>, not pushed</span>
                  )}
                </div>
                {checked ? <div style={{ color: COLORS.textDim }}>{checked}</div> : null}
              </div>
            ) : (
              <div className="mb-3 text-[12px]" style={{ color: COLORS.textMuted }}>
                ADE Cloud has no saved Git state for this lane yet.
              </div>
            )}
            {files ? (
              files.length === 0 ? (
                <div className="text-[12px]" style={{ color: COLORS.textMuted }}>No uncommitted changes.</div>
              ) : (
                <div className="flex flex-col" data-testid="lane-detail-cloud-files">
                  <div className="mb-1 text-[12px] font-medium" style={{ color: COLORS.textSecondary }}>
                    {files.length === 1 ? "1 changed file" : `${files.length} changed files`}
                  </div>
                  {listed.map((file) => (
                    <div key={file.path} className="flex items-center gap-2 py-0.5 text-[12px]">
                      <span className="w-3 shrink-0 text-center" style={{ color: COLORS.textDim }}>{KIND_LETTER[file.kind]}</span>
                      <span className="min-w-0 flex-1 truncate" style={{ color: COLORS.textPrimary }} title={file.path}>{file.path}</span>
                      {file.additions ? <span style={{ color: COLORS.success }}>+{file.additions}</span> : null}
                      {file.deletions ? <span style={{ color: COLORS.danger }}>−{file.deletions}</span> : null}
                    </div>
                  ))}
                  {files.length > listed.length ? (
                    <div className="pt-1 text-[12px]" style={{ color: COLORS.textDim }}>
                      {files.length - listed.length} more. Wake the computer to see all of them.
                    </div>
                  ) : null}
                </div>
              )
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
