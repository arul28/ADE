import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  EyeSlash,
  GitBranch,
  Terminal,
  Trash,
  XCircle,
} from "@phosphor-icons/react";
import type { AgentChatCrossMachineHandoffOptionsResult } from "../../../shared/types";
import type { CloudKeptLaneRestorePreview } from "../../../shared/cloudKeptLaneRestore";
import { ignoredFilesList, type CloudIgnoredFiles } from "../../../shared/adeCloud";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import { ADE_CLOUD_NAME } from "../../../shared/adeCloudMachine";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { Dialog } from "../ui/dialog";
import { Banner } from "../ui/notice";
import { showToast } from "../app/toast/toastStore";
import { cn } from "../ui/cn";
import { ProviderLogo } from "../shared/ProviderLogos";
import { describeTravellingChanges } from "../chat/CrossMachineHandoffBanner";
import { requireChatPin } from "../chat/chatMachinePin";
import {
  laneMoveErrorText as errorText,
  laneMoveItems,
  laneMoveRestores,
  type LaneMoveChatHistory,
  type LaneMoveItem,
  type LaneMoveSource,
} from "./laneMoveModel";
import type { LaneMoveTarget } from "./useLaneMoveTargets";
import {
  dismissLaneMove,
  followLiveLaneMove,
  keptLaneRestoreApi,
  followRestoreLaneMove,
  laneMoveWakesInstead,
  retryLaneMoveDelete,
  useLaneMoveRun,
  type LaneMoveRun,
} from "./laneMoveRuns";

/**
 * The step between a pick in the lane's machine menu and the move itself. It
 * says, before anything runs, what goes where: each chat and CLI with how
 * much of its history arrives, that the work comes along and nothing is
 * pushed, where a missing project is cloned, and, for an ADE Cloud lane, that
 * its computer is deleted only once everything arrived. The move starts only
 * from its "Move lane" button. Once it starts, the same dialog follows it.
 *
 * A lane whose ADE Cloud computer is asleep moves from its saved copy, with no
 * wake, when that copy holds all of the lane's work; else the dialog says why
 * and offers "Wake and move", which moves it live.
 */

type Row = { id: string; title: string; kind: "chat" | "cli" | "lane"; provider: string; history: RowHistory };
type RowHistory = LaneMoveChatHistory | "transcript" | "fresh";
type RowState = "pending" | "moving" | "done" | "failed";

type Review =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      rows: Row[];
      work: string | null;
      hasRepository: boolean | null;
      /** An asleep computer's saved copy: complete, or why not (the move then wakes it). */
      saved: { ok: boolean; reason: string | null } | null;
      /** The asleep computer's ignored files, read with no wake. */
      ignored: CloudIgnoredFiles | null;
      /** A move from saved copies: the titles of chats on another computer of the person's, which keep the lane on ADE Cloud. */
      blocked: string[];
    };

const HISTORY_LABEL: Record<RowHistory, string> = {
  full: "Full history",
  summary: "Summary",
  transcript: "Saved transcript",
  fresh: "Starts fresh",
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function restoreWork(work: CloudKeptLaneRestorePreview["work"]): string | null {
  if (!work) return null;
  return describeTravellingChanges(work.unpushedCommits ?? 0, work.changedFiles ?? 0)
    ?? "the work this lane saved when its computer stopped";
}

/**
 * The files git ignores on the ADE Cloud computer, which no move carries and
 * which go with the computer: named when the computer said which.
 */
function ignoredFilesNote(ignored: CloudIgnoredFiles | null | undefined, asleep: boolean): string | null {
  const after = asleep ? " To copy them first, wake the computer and move the lane from there." : " Copy them yourself first if you need them.";
  if (!ignored) return `Files git ignores (such as .env) don't move, and they go with the computer.${after}`;
  const list = ignoredFilesList(ignored);
  // A scan that stopped early and named nothing still can't promise there are none.
  if (!list) return ignored.incomplete ? `Files git ignores (such as .env) may not move, and they go with the computer.${after}` : null;
  return `Files git ignores don't move, and they go with the computer: ${list}.${ignored.incomplete ? " There may be more." : ""}${after}`;
}

function itemRow(item: LaneMoveItem): Row {
  return { id: item.sessionId, title: item.title, kind: item.kind, provider: item.provider, history: item.history };
}

export function LaneMoveDialog({
  source,
  target,
  changes,
  onWake,
  onClose,
}: {
  source: LaneMoveSource;
  target: LaneMoveTarget;
  /** A live move: the work that travels, from the options the menu read. */
  changes: AgentChatCrossMachineHandoffOptionsResult["changes"] | null;
  /** Wakes the asleep ADE Cloud computer, for a live move instead. */
  onWake?: () => void;
  onClose: () => void;
}) {
  const restores = laneMoveRestores(source.kind);
  const asleepInstanceId = source.kind === "cloudAsleep" ? source.cloudInstanceId : null;
  const fromComputer = asleepInstanceId ? { instanceId: asleepInstanceId } : null;
  // An awake ADE Cloud computer's ignored files, from the list the app already reads.
  const cloudMachines = useCloudMachines(source.kind === "cloud");
  const liveIgnored = source.kind === "cloud"
    ? cloudMachines.result?.machines.find((machine) => machine.instanceId === source.cloudInstanceId)?.ignoredFiles ?? null
    : null;
  const [review, setReview] = useState<Review>({ status: "loading" });
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [cloneFolder, setCloneFolder] = useState<string | null>(null);
  const run = useLaneMoveRun(runId);
  const deletesComputer = source.kind !== "own" && Boolean(source.cloudInstanceId);
  const sourcePinKey = source.pin?.key ?? null;
  const targetPinKey = target.pin?.key ?? null;

  useEffect(() => {
    if (runId) return;
    let cancelled = false;
    setReview({ status: "loading" });
    const load = async (): Promise<Review> => {
      if (restores) {
        const preview = await keptLaneRestoreApi().preview(
          { laneId: source.laneId, ...(fromComputer ? { fromComputer } : {}) },
          requireChatPin(target.pin),
        );
        return {
          status: "ready",
          rows: preview.chats.map((chat) => ({
            id: chat.chatId,
            title: chat.title?.trim() || (chat.kind === "cli" ? "CLI session" : "Untitled chat"),
            kind: chat.kind,
            provider: chat.provider ?? "",
            history: chat.history,
          })),
          work: restoreWork(preview.work),
          hasRepository: preview.hasRepository,
          saved: preview.fromComputer ? { ok: preview.fromComputer.saved, reason: preview.fromComputer.reason } : null,
          ignored: preview.fromComputer?.ignored ?? null,
          blocked: (preview.blocked ?? []).map((chat) => chat.title?.trim() || (chat.kind === "cli" ? "CLI session" : "Untitled chat")),
        };
      }
      const pin = requireChatPin(source.pin);
      const [rows, chats] = await Promise.all([
        window.ade.sessions.list({ laneId: source.laneId, includeArchived: false, limit: null }, pin),
        window.ade.agentChat.list({ laneId: source.laneId }, pin),
      ]);
      return {
        status: "ready",
        rows: laneMoveItems(rows, chats).map(itemRow),
        work: changes ? describeTravellingChanges(changes.unpushedCommits, changes.changedFiles) : null,
        hasRepository: target.hasRepository,
        saved: null,
        ignored: null,
        blocked: [],
      };
    };
    load()
      .then((next) => { if (!cancelled) setReview(next); })
      .catch((error: unknown) => { if (!cancelled) setReview({ status: "error", message: errorText(error) }); });
    return () => { cancelled = true; };
    // Keyed on the pins' keys: a rebuilt pin is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, restores, source.laneId, sourcePinKey, targetPinKey, target.hasRepository, changes, asleepInstanceId]);

  // Where a clone lands on this computer, said in the dialog. Another
  // machine clones beside its own newest project, which only it knows.
  useEffect(() => {
    if (!target.thisComputer || target.hasRepository !== false || restores) return;
    let cancelled = false;
    void window.ade.project?.getDefaultParentDir?.()
      .then((dir) => { if (!cancelled) setCloneFolder(dir || null); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [target.thisComputer, target.hasRepository, restores]);

  const rows = review.status === "ready" ? review.rows : [];
  const summaryRows = rows.filter((row) => row.history === "summary" || row.history === "fresh");

  const start = async () => {
    if (starting || review.status !== "ready") return;
    setStarting(true);
    setStartError(null);
    try {
      if (restores) {
        const pin = requireChatPin(target.pin);
        const record = await keptLaneRestoreApi().restore({ laneId: source.laneId, ...(fromComputer ? { fromComputer } : {}) }, pin);
        // The destination's brain deletes an asleep computer itself, first; nothing is deleted after.
        setRunId(followRestoreLaneMove({
          record,
          pin,
          targetName: target.name,
          cloudInstanceId: null,
          fromComputer: asleepInstanceId,
        }));
      } else {
        const pin = requireChatPin(source.pin);
        const record = await window.ade.agentChat.startCrossMachineBatchMove({
          machine: target.key,
          sessionIds: rows.map((row) => row.id),
          includeDescendants: true,
          mode: "fork",
          includeChanges: true,
          whenBusy: "wait",
          ...(target.hasRepository === false ? { clone: true } : {}),
        }, pin);
        setRunId(followLiveLaneMove({
          record,
          pin,
          laneId: source.laneId,
          laneName: source.laneName,
          cloudInstanceId: deletesComputer ? source.cloudInstanceId : null,
        }));
      }
    } catch (error) {
      setStartError(errorText(error));
    } finally {
      setStarting(false);
    }
  };

  const title = `Move ${source.laneName} to ${target.name}`;
  if (run) {
    return <LaneMoveProgress title={title} run={run} rows={rows} onRunId={setRunId} onWake={onWake} onClose={onClose} />;
  }

  const savedCopyIncomplete = review.status === "ready" && review.saved?.ok === false;
  // A move from saved copies runs in the project there: one that isn't the lane's repository can't take it.
  const wrongRepository = restores && review.status === "ready" && review.hasRepository === false;
  // An asleep computer whose saved copy couldn't be read at all: waking it still moves the lane.
  const wakes = Boolean(onWake) && (savedCopyIncomplete || (Boolean(asleepInstanceId) && review.status === "error"));
  // A move from saved copies brings the branch and its work even with no chat to bring.
  const canMove = review.status === "ready" && (rows.length > 0 || restores) && !starting && !savedCopyIncomplete && !wrongRepository;
  const blocked = review.status === "ready" ? review.blocked : [];
  const ignoredNote = review.status !== "ready" || savedCopyIncomplete
    ? null
    : asleepInstanceId ? ignoredFilesNote(review.ignored, true)
      : source.kind === "cloud" ? ignoredFilesNote(liveIgnored, false)
        : null;
  const primary = wakes && onWake
    ? { label: "Wake and move", variant: "solid" as const, autoFocus: true, onClick: () => { onClose(); onWake(); } }
    : { label: "Move lane", variant: "solid" as const, autoFocus: true, busy: starting, disabled: !canMove, onClick: () => void start() };
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={title}
      description={`From ${machinePhrase(source.machineName)}. Everything on this lane moves together.`}
      size="md"
      testId="lane-move-dialog"
      actions={[primary, { label: "Cancel", variant: "secondary", onClick: onClose }]}
    >
      {review.status === "loading" ? (
        <div className="flex items-center gap-2 py-6 text-[12px] text-muted-fg/70">
          <CircleNotch size={14} className="animate-spin" aria-hidden /> Reading the lane…
        </div>
      ) : review.status === "error" ? (
        <Banner
          layout="inline"
          model={{
            id: "lane-move-review-error",
            tone: "error",
            title: "ADE couldn't read what this lane holds.",
            detail: wakes ? `${review.message} Wake the ${ADE_CLOUD_NAME} computer to move the lane from there.` : review.message,
          }}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <section aria-label="What moves">
            {rows.length === 0 ? (
              <p className="text-[12px] text-muted-fg/75">
                {restores ? "No chats or CLI sessions come back with it. The branch and its work do." : "This lane has no chats or CLI sessions to move."}
              </p>
            ) : (
              <ul className="overflow-hidden rounded-lg border border-border/60" data-testid="lane-move-items">
                {rows.map((row) => <ItemRow key={row.id} row={row} />)}
              </ul>
            )}
            {summaryRows.length > 0 ? (
              <p className={cn("mt-2 text-[11.5px] leading-relaxed", deletesComputer ? "text-amber-200/90" : "text-muted-fg/75")}>
                {summaryNote(summaryRows, source, deletesComputer, restores)}
              </p>
            ) : null}
          </section>
          <div className="flex flex-col gap-2.5">
            <Fact icon={<GitBranch size={15} className="text-muted-fg/70" />}>
              {review.work
                ? <>The branch comes with {review.work}. Nothing is pushed.</>
                : <>The branch comes with it. Nothing is pushed.</>}
            </Fact>
            {wrongRepository ? (
              <Banner
                layout="inline"
                model={{
                  id: "lane-move-wrong-repository",
                  tone: "warning",
                  report: false,
                  title: `This project on ${target.name} isn't the lane's repository.`,
                  detail: "Open a clone of it there, then move the lane there.",
                }}
              />
            ) : review.hasRepository === false ? (
              <Fact icon={<DownloadSimple size={15} className="text-muted-fg/70" />}>
                {target.name} doesn't have this project yet. ADE clones it from GitHub first
                {cloneFolder ? <>, into <span className="font-mono text-[11px] text-fg/85">{cloneFolder}</span></> : <>, into the folder beside its newest project</>}
                . To use another folder, open the project there first.
              </Fact>
            ) : null}
            {savedCopyIncomplete ? (
              <Banner
                layout="inline"
                model={{
                  id: "lane-move-saved-copy-incomplete",
                  tone: "warning",
                  report: false,
                  title: review.saved?.reason ?? "The computer's saved copy isn't complete.",
                  detail: `So ADE wakes the computer and moves the lane from there. Waking it uses ${ADE_CLOUD_NAME} hours.`,
                }}
              />
            ) : asleepInstanceId ? (
              <Fact icon={<Trash size={15} className="text-muted-fg/70" />}>
                The {ADE_CLOUD_NAME} computer stays asleep. It saved all of this lane's work when it went to sleep, so ADE
                deletes it first and brings the lane back from that saved copy. If anything fails after that, the lane
                stays in your account and you can move it again.
              </Fact>
            ) : deletesComputer ? (
              <Fact icon={<Trash size={15} className="text-muted-fg/70" />}>
                When everything has arrived and ADE has checked it, ADE deletes this lane's {ADE_CLOUD_NAME} computer
                and the saved copies of the chats that moved. If anything fails, the computer stays.
              </Fact>
            ) : null}
            {ignoredNote ? (
              <Fact icon={<EyeSlash size={15} className="text-muted-fg/70" />}>{ignoredNote}</Fact>
            ) : null}
            {blocked.length > 0 ? (
              <Banner
                layout="inline"
                model={{
                  id: "lane-move-blocked-chats",
                  tone: "warning",
                  report: false,
                  title: blocked.length === 1
                    ? `“${blocked[0]}” is on another computer of yours now.`
                    : `${blocked.length} chats are on other computers of yours now.`,
                  detail: `They don't come here, so the lane stays on ${ADE_CLOUD_NAME} too. Finish their move there, then move the lane again.`,
                }}
              />
            ) : null}
            {startError ? (
              <Banner layout="inline" model={{ id: "lane-move-start-error", tone: "error", title: "Couldn't start the move.", detail: startError }} />
            ) : null}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function summaryNote(rows: Row[], source: LaneMoveSource, deletesComputer: boolean, restores: boolean): string {
  const names = rows.map((row) => `“${row.title}”`).join(", ");
  const one = rows.length === 1;
  const start = restores
    ? `${names} ${one ? "starts" : "start"} fresh there. ${one ? "Its earlier session doesn't" : "Their earlier sessions don't"} come back.`
    : one
      ? `${names} arrives as a summary. Its agent can't carry its full history to another machine.`
      : `${names} arrive as summaries. Their agents can't carry their full history to another machine.`;
  if (deletesComputer) return `${start} The full history is deleted with the ${ADE_CLOUD_NAME} computer.`;
  return `${start} The full history stays on ${machinePhrase(source.machineName)}.`;
}

/** "This computer" reads as a name in a label and as words in a sentence. */
function machinePhrase(name: string): string {
  return name === THIS_MACHINE_NAME ? "this computer" : name;
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 text-[12px] leading-relaxed text-fg/80">
      <span className="mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>{icon}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function ItemRow({ row, state }: { row: Row; state?: RowState }) {
  const reduced = row.history !== "full";
  return (
    <li className="flex min-h-9 items-center gap-2.5 border-b border-border/40 px-3 py-1.5 last:border-b-0" data-testid="lane-move-item">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
        {row.kind === "lane"
          ? <GitBranch size={14} className="text-muted-fg/75" />
          : row.provider
            ? <ProviderLogo family={row.provider} size={14} />
            : <Terminal size={14} className="text-muted-fg/70" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-fg/90">{row.title}</span>
      {row.kind === "cli" ? <span className="shrink-0 text-[10.5px] text-muted-fg/55">CLI</span> : null}
      {state ? <RowStateMark state={state} /> : (
        <span className={cn("shrink-0 text-[11px]", reduced ? "text-amber-200/85" : "text-muted-fg/65")}>
          {HISTORY_LABEL[row.history]}
        </span>
      )}
    </li>
  );
}

function RowStateMark({ state }: { state: RowState }) {
  switch (state) {
    case "done":
      return <CheckCircle size={15} weight="fill" className="shrink-0 text-emerald-400/90" aria-label="Arrived" />;
    case "failed":
      return <XCircle size={15} weight="fill" className="shrink-0 text-rose-400/90" aria-label="Did not arrive" />;
    case "moving":
      return <CircleNotch size={14} className="shrink-0 animate-spin text-muted-fg/70" aria-label="Moving" />;
    default:
      return <span className="mr-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted-fg/35" aria-label="Waiting" />;
  }
}

/** Each part of a run, as the progress view lists it: the lane first, then its chats. */
function progressRows(run: LaneMoveRun, reviewRows: Row[]): Array<{ row: Row; state: RowState; error: string | null }> {
  const byId = new Map(reviewRows.map((row) => [row.id, row]));
  if (run.kind === "live") {
    const items = run.record?.items ?? [];
    return items.map((item) => {
      const state: RowState = item.state === "continued"
        ? "done"
        : item.state === "failed" || item.state === "cancelled" || item.state === "blocked" || item.state === "unknown"
          ? "failed"
          : item.state === "sending" ? "moving" : "pending";
      if (item.kind === "lane") {
        return {
          row: { id: item.id, title: "Branch and work", kind: "lane" as const, provider: "", history: "full" as const },
          state,
          error: item.error ?? null,
        };
      }
      const known = byId.get(item.sourceSessionId);
      return {
        row: known ?? {
          id: item.sourceSessionId,
          title: item.sourceChatTitle?.trim() || "Chat",
          kind: "chat" as const,
          provider: "",
          history: item.mode === "fork" ? "full" as const : "summary" as const,
        },
        state,
        error: item.error ?? null,
      };
    });
  }
  const record = run.record;
  // While an asleep computer is released, the lane waits; a refused release touched nothing.
  const laneState: RowState = !record ? "moving"
    : record.step === "release" ? "pending"
      : record.step === "lane" ? (record.state === "failed" ? "failed" : "moving") : "done";
  const lane = { row: { id: "lane", title: "Branch and work", kind: "lane" as const, provider: "", history: "full" as const }, state: laneState, error: null };
  return [lane, ...(record?.chats ?? []).map((chat) => ({
    row: byId.get(chat.chatId) ?? {
      id: chat.chatId,
      title: chat.title?.trim() || "Chat",
      kind: "chat" as const,
      provider: "",
      history: chat.history ?? "full",
    },
    state: (chat.state === "restored" ? "done" : chat.state === "failed" ? "failed" : record?.step === "chats" ? "moving" : "pending") as RowState,
    error: chat.error,
  }))];
}

/** The one line above the progress rows: where the move is, or how it ended. */
function progressStatus(run: LaneMoveRun, arrived: number, total: number): string {
  if (laneMoveWakesInstead(run)) {
    return `ADE didn't use the saved copy, and nothing was deleted. Wake the ${ADE_CLOUD_NAME} computer to move the lane from there.`;
  }
  const deletesComputer = Boolean(run.cloudInstanceId || (run.kind === "restore" && run.fromComputer));
  switch (run.phase) {
    case "moving":
      if (run.kind === "restore" && run.record?.step === "release") return `Deleting the asleep ${ADE_CLOUD_NAME} computer and keeping its lane…`;
      return total ? `Moving: ${arrived} of ${plural(total, "part")} arrived.` : "Starting the move…";
    case "deleting":
      return `Everything arrived. Deleting the ${ADE_CLOUD_NAME} computer…`;
    case "done":
      return deletesComputer ? `Moved. The ${ADE_CLOUD_NAME} computer is deleted.` : "Moved. Everything arrived.";
    case "deleteFailed":
      return `Everything arrived, but the ${ADE_CLOUD_NAME} computer is still there.`;
    default:
      if (run.cloudInstanceId) return `Not all of it arrived. The ${ADE_CLOUD_NAME} computer is kept, so nothing is lost.`;
      if (run.kind === "restore" && run.fromComputer) return "Not all of it arrived. The lane stays in your account, so nothing is lost.";
      return "Not all of it arrived.";
  }
}

/**
 * A move already under way, opened from the lane's machine menu: the same
 * progress view, with the parts its record names.
 */
export function LaneMoveProgressDialog({ runId: firstRunId, onWake, onClose }: {
  runId: string;
  onWake?: () => void;
  onClose: () => void;
}) {
  const [runId, setRunId] = useState(firstRunId);
  const run = useLaneMoveRun(runId);
  useEffect(() => {
    if (!run) onClose();
  }, [run, onClose]);
  if (!run) return null;
  return (
    <LaneMoveProgress
      title={`Move ${run.laneName} to ${run.targetName}`}
      run={run}
      rows={NO_ROWS}
      onRunId={setRunId}
      onWake={onWake}
      onClose={onClose}
    />
  );
}

const NO_ROWS: Row[] = [];

function LaneMoveProgress({ title, run, rows, onRunId, onWake, onClose }: {
  title: string;
  run: LaneMoveRun;
  rows: Row[];
  /** A try again that started a new run: the view follows that one. */
  onRunId: (id: string) => void;
  onWake?: () => void;
  onClose: () => void;
}) {
  const parts = useMemo(() => progressRows(run, rows), [run, rows]);
  const arrived = parts.filter((part) => part.state === "done").length;
  const failure = parts.find((part) => part.state === "failed" && part.error)?.error ?? run.error;
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      let next: string;
      if (run.kind === "live") {
        const record = await window.ade.agentChat.retryCrossMachineBatchMove({ batchId: run.id }, run.pin);
        next = followLiveLaneMove({ record, pin: run.pin, laneId: run.laneId, laneName: run.laneName, cloudInstanceId: run.cloudInstanceId });
      } else {
        const fromComputer = run.fromComputer ? { instanceId: run.fromComputer } : null;
        const record = await keptLaneRestoreApi().restore({ laneId: run.laneId, ...(fromComputer ? { fromComputer } : {}) }, run.pin);
        next = followRestoreLaneMove({ record, pin: run.pin, targetName: run.targetName, cloudInstanceId: run.cloudInstanceId, fromComputer: run.fromComputer });
      }
      // A restore's new start has its own id; the ended run goes from the list.
      if (next !== run.id) {
        onRunId(next);
        dismissLaneMove(run.id);
      }
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't try the move again`, message: errorText(error) });
    } finally {
      setRetrying(false);
    }
  };
  const wakesInstead = laneMoveWakesInstead(run);
  const status = progressStatus(run, arrived, parts.length);
  const actions = wakesInstead && onWake
    ? [
      { label: "Wake and move", variant: "solid" as const, onClick: () => { dismissLaneMove(run.id); onClose(); onWake(); } },
      { label: "Close", variant: "secondary" as const, onClick: () => { dismissLaneMove(run.id); onClose(); } },
    ]
    : run.phase === "failed"
    ? [
      { label: "Try again", variant: "solid" as const, busy: retrying, onClick: () => void retry() },
      { label: "Close", variant: "secondary" as const, onClick: () => { dismissLaneMove(run.id); onClose(); } },
    ]
    : run.phase === "deleteFailed"
      ? [
        { label: `Delete ${ADE_CLOUD_NAME} computer`, variant: "solid" as const, onClick: () => retryLaneMoveDelete(run.id) },
        { label: "Close", variant: "secondary" as const, onClick: onClose },
      ]
      : [{ label: run.phase === "done" ? "Done" : "Close", variant: "secondary" as const, autoFocus: true, onClick: onClose }];
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={title}
      description={run.phase === "moving" || run.phase === "deleting"
        ? "You can close this. The move goes on, and each chat shows its own progress."
        : undefined}
      size="md"
      testId="lane-move-progress"
      actions={actions}
    >
      <div className="flex flex-col gap-3">
        <p className={cn(
          "text-[12px] leading-relaxed",
          run.phase === "failed" || run.phase === "deleteFailed" ? "text-amber-200/90" : "text-fg/80",
        )} role="status">
          {status}
        </p>
        {parts.length > 0 && !wakesInstead ? (
          <ul className="overflow-hidden rounded-lg border border-border/60" data-testid="lane-move-progress-items">
            {parts.map((part) => <ItemRow key={part.row.id} row={part.row} state={part.state} />)}
          </ul>
        ) : null}
        {failure && (run.phase === "failed" || run.phase === "deleteFailed") ? (
          <p className="text-[11.5px] leading-relaxed text-muted-fg/80">{failure}</p>
        ) : null}
      </div>
    </Dialog>
  );
}
