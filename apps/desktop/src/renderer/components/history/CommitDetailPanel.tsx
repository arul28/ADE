import React, { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  Copy,
  GitBranch,
  Hash,
  X,
} from "@phosphor-icons/react";
import type { GitCommitSummary } from "../../../shared/types";
import type { TimelineEvent } from "./timelineTypes";
import { Button } from "../ui/Button";
import { formatDate } from "../../lib/format";
import { buildCommitContextActions, runHistoryGitAction } from "./historyGitActions";

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function copyText(text: string) {
  void navigator.clipboard.writeText(text);
}

type CommitDetailPanelProps = {
  laneId: string | null;
  commit: GitCommitSummary | null;
  relatedEvents: TimelineEvent[];
  onClose: () => void;
  onNavigateToLane?: (laneId: string) => void;
  navigate?: (path: string) => void;
};

export function CommitDetailPanel({
  laneId,
  commit,
  relatedEvents,
  onClose,
  onNavigateToLane,
  navigate,
}: CommitDetailPanelProps) {
  const [fullMessage, setFullMessage] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [metaExpanded, setMetaExpanded] = useState(false);

  const [resolvedCommit, setResolvedCommit] = useState<GitCommitSummary | null>(commit);

  useEffect(() => {
    setResolvedCommit(commit);
  }, [commit]);

  useEffect(() => {
    if (!laneId || !commit?.sha || (commit.subject && commit.authorName)) return;
    let cancelled = false;
    void window.ade.git
      .listRecentCommits({ laneId, limit: 200 })
      .then((rows) => {
        if (cancelled) return;
        const found = rows.find((r) => r.sha === commit.sha);
        if (found) setResolvedCommit(found);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [laneId, commit]);

  useEffect(() => {
    const activeCommit = resolvedCommit;
    if (!laneId || !activeCommit) {
      setFullMessage(null);
      setFiles([]);
      return;
    }
    let cancelled = false;
    void window.ade.git
      .getCommitMessage({ laneId, commitSha: activeCommit.sha })
      .then((msg) => {
        if (!cancelled) setFullMessage(msg.trim() || activeCommit.subject);
      })
      .catch(() => {
        if (!cancelled) setFullMessage(activeCommit.subject);
      });
    setLoadingFiles(true);
    void window.ade.git
      .listCommitFiles({ laneId, commitSha: activeCommit.sha })
      .then((rows) => {
        if (!cancelled) setFiles(rows);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingFiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, resolvedCommit]);

  const actions = useMemo(
    () =>
      resolvedCommit
        ? buildCommitContextActions({
            commit: resolvedCommit,
            isHead: false,
            hasWorktree: Boolean(laneId),
          })
        : [],
    [resolvedCommit, laneId],
  );

  return (
    <AnimatePresence mode="wait">
      {resolvedCommit && laneId ? (
        <motion.div
          key={resolvedCommit.sha}
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 12 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="flex h-full flex-col overflow-y-auto"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch size={14} className="shrink-0 text-accent" />
              <span className="truncate font-mono text-[12px] font-semibold text-fg">
                {resolvedCommit.shortSha}
              </span>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
              <X size={14} />
            </Button>
          </div>

          <div className="flex flex-col gap-3 p-3">
            <p className="font-sans text-[13px] leading-snug text-fg">
              {fullMessage ?? resolvedCommit.subject}
            </p>

            <div className="grid grid-cols-2 gap-2">
              <Meta label="Author" value={resolvedCommit.authorName || "—"} />
              <Meta label="Date" value={formatDate(resolvedCommit.authoredAt)} />
              <Meta
                label="Parents"
                value={
                  resolvedCommit.parents.length
                    ? resolvedCommit.parents.map(shortSha).join(", ")
                    : "—"
                }
              />
              <Meta
                label="Push"
                value={resolvedCommit.pushed ? "On remote" : "Local only"}
              />
            </div>

            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 font-mono text-[10px] text-muted-fg hover:bg-white/5"
                onClick={() => copyText(resolvedCommit.sha)}
              >
                <Hash size={10} />
                {shortSha(resolvedCommit.sha)}
                <Copy size={10} />
              </button>
              {onNavigateToLane ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 font-mono text-[10px] text-accent hover:bg-white/5"
                  onClick={() => onNavigateToLane(laneId)}
                >
                  <ArrowSquareOut size={10} />
                  Open lane
                </button>
              ) : null}
            </div>

            <div className="flex flex-col gap-1">
              <span className="font-sans text-[10px] font-bold uppercase tracking-wider text-muted-fg">
                Git actions
              </span>
              <div className="flex flex-wrap gap-1">
                {actions
                  .filter((a) => !["copy_sha", "copy_subject"].includes(a.id))
                  .map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      disabled={action.disabled}
                      title={action.disabledReason}
                      className="rounded border border-white/10 px-2 py-1 font-sans text-[11px] text-fg hover:bg-white/5 disabled:opacity-40"
                      onClick={() =>
                        void runHistoryGitAction({
                          actionId: action.id,
                          laneId,
                          commit: resolvedCommit,
                          navigate,
                        })
                      }
                    >
                      {action.label}
                    </button>
                  ))}
              </div>
            </div>

            <section>
              <button
                type="button"
                className="flex w-full items-center gap-1 font-sans text-[10px] font-bold uppercase tracking-wider text-muted-fg"
                onClick={() => setMetaExpanded((v) => !v)}
              >
                {metaExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                Changed files ({loadingFiles ? "…" : files.length})
              </button>
              {metaExpanded ? (
                <ul className="mt-1 max-h-40 overflow-auto rounded border border-white/[0.06] bg-white/[0.02] p-1">
                  {files.length === 0 ? (
                    <li className="px-2 py-1 font-mono text-[10px] text-muted-fg">
                      {loadingFiles ? "Loading…" : "No file list"}
                    </li>
                  ) : (
                    files.slice(0, 80).map((path) => (
                      <li
                        key={path}
                        className="truncate px-2 py-0.5 font-mono text-[10px] text-fg"
                        title={path}
                      >
                        {path}
                      </li>
                    ))
                  )}
                </ul>
              ) : null}
            </section>

            {relatedEvents.length > 0 ? (
              <section>
                <span className="font-sans text-[10px] font-bold uppercase tracking-wider text-muted-fg">
                  ADE operations ({relatedEvents.length})
                </span>
                <ul className="mt-1 flex flex-col gap-1">
                  {relatedEvents.slice(0, 8).map((ev) => (
                    <li
                      key={ev.id}
                      className="rounded border border-white/[0.06] bg-white/[0.02] px-2 py-1"
                    >
                      <div className="font-sans text-[11px] text-fg">{ev.label}</div>
                      <div className="font-mono text-[10px] text-muted-fg">
                        {ev.status} · {formatDate(ev.startedAt)}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </motion.div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-4 font-mono text-[11px] text-muted-fg/50">
          Select a commit or event
        </div>
      )}
    </AnimatePresence>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-sans text-[10px] font-bold uppercase tracking-wider text-muted-fg">
        {label}
      </span>
      <span className="font-mono text-[11px] text-fg">{value}</span>
    </div>
  );
}
