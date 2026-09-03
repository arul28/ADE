/**
 * One agent, in full.
 *
 * Written ONCE and mounted twice: the fleet embeds it as its right pane, and
 * the `agent` surface mounts it alone for a deeplink. That is the whole reason
 * it takes an `agentId` and an optional `onClose` rather than reading the page
 * context itself — a component that read the context could only ever be the
 * standalone one, and the fleet would need a second copy of every line here.
 *
 * It is assembled from three compiled places, because the compiled app had no
 * single one:
 *
 * - the fleet row's expansion, for the summary, the short ids and the token line
 * - `ChatCursorCloudPanel`'s active-run rows, for the per-run strip
 * - the composer's send path, for the follow-up box
 *
 * The artifacts list has no compiled ancestor at all. It exists because the
 * plugin declares `capabilities.artifacts` on its chat runtime and the child
 * answers `CloudArtifact[]`, and it is deliberately the plainest thing on the
 * page: a path, a size and a press that hands the signed URL to the host.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, CircleNotch, GitPullRequest, PaperPlaneRight, Stop, X } from "@phosphor-icons/react";
import { cn } from "@ade-dev/ui";

import type { CloudAgentPage, CloudUsage } from "../types";
import { followUp as sendFollowUp, getAgentPage, stopRun } from "../host/actions";
import { openLink } from "../host/ui";
import { useHostRefresh } from "../host/refresh";
import { useCollectionChanges } from "../host/useHostEntities";
import { artifactSizeLabel } from "../lib/cursorCloud";
import { StatusPill } from "./FleetRow";

export function AgentDetail({
  agentId,
  onClose,
  onUsage,
  onChanged,
}: {
  agentId: string;
  /** Given by the fleet, absent on the standalone surface, which has no pane to close. */
  onClose?: () => void;
  /** Hands the usage back up so the fleet row can wear its cost chip. */
  onUsage?: (agentId: string, usage: CloudUsage | null) => void;
  /** Something changed on Cursor's side; the fleet should re-read. */
  onChanged?: () => void;
}): React.ReactElement {
  const [page, setPage] = useState<CloudAgentPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * One read wins, and it is the newest one.
   *
   * The reader can click through four rows faster than one `pageAgent` answers
   * on a cold Cursor connection, and without the generation guard the third
   * row's answer would paint over the fourth row's.
   */
  const requestRef = useRef(0);
  const usageRef = useRef(onUsage);
  usageRef.current = onUsage;

  const load = useCallback(() => {
    const generation = requestRef.current + 1;
    requestRef.current = generation;
    setLoading(true);
    void getAgentPage(agentId)
      .then((next) => {
        if (requestRef.current !== generation) return;
        setPage(next);
        setError(null);
        usageRef.current?.(agentId, next.usage);
      })
      .catch((err: unknown) => {
        if (requestRef.current !== generation) return;
        setError(err instanceof Error ? err.message : "Could not load this cloud agent.");
      })
      .finally(() => {
        if (requestRef.current === generation) setLoading(false);
      });
  }, [agentId]);

  useEffect(() => {
    setDraft("");
    setNotice(null);
    load();
  }, [load]);

  // Both freshness channels, and no timer: the reader's pull-down, and the
  // child writing the `fleet` collection when a relay delivery lands.
  useHostRefresh(load);
  useCollectionChanges(load, "fleet");

  const entry = page?.entry ?? null;
  const active = entry?.active === true;
  /**
   * The one sentence that replaces the body, or null.
   *
   * Three sources collapse into it and the order matters: a transport failure
   * the page saw itself, then the child's own worded refusal, and only then the
   * "no such agent here" fallback — which must not be said while a read is
   * still in flight, because an agent that simply has not arrived yet is not an
   * agent that is missing.
   */
  const problem = error
    ?? page?.error
    ?? (page && !entry ? "It is not in this project's fleet." : null);

  const runStop = useCallback(() => {
    setBusy(true);
    setNotice(null);
    void stopRun(agentId)
      .then((result) => {
        setNotice(result.message ?? null);
        if (result.ok) {
          load();
          onChanged?.();
        }
      })
      .catch((err: unknown) => {
        setNotice(err instanceof Error ? err.message : "Could not stop this run.");
      })
      .finally(() => setBusy(false));
  }, [agentId, load, onChanged]);

  const submitFollowUp = useCallback(() => {
    const prompt = draft.trim();
    if (!prompt || !active) return;
    setBusy(true);
    setNotice(null);
    void sendFollowUp(agentId, prompt)
      .then((result) => {
        setNotice(result.message ?? null);
        if (result.ok) {
          setDraft("");
          load();
          onChanged?.();
        }
      })
      .catch((err: unknown) => {
        setNotice(err instanceof Error ? err.message : "Could not send that to Cursor Cloud.");
      })
      .finally(() => setBusy(false));
  }, [active, agentId, draft, load, onChanged]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--color-bg)]">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/[0.07] px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-sans text-[12.5px] font-semibold tracking-tight text-fg/88">
              {entry?.agent.name || agentId.slice(0, 12)}
            </span>
            {entry ? <StatusPill status={entry.status} /> : null}
            {entry?.age ? (
              <span className="shrink-0 font-mono text-[10px] text-fg/35">{entry.age}</span>
            ) : null}
          </div>
          {entry?.agent.summary && entry.agent.summary !== entry.agent.name ? (
            <p className="mt-1 line-clamp-3 text-[11.5px] leading-relaxed text-fg/60">
              {entry.agent.summary}
            </p>
          ) : null}
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close agent detail"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/[0.07] text-fg/50 transition-colors hover:border-white/[0.16] hover:text-fg/85"
          >
            <X size={13} weight="bold" />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && !page ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-fg/45">
            <CircleNotch size={18} weight="bold" className="animate-spin" />
            <span className="text-[12px]">Loading cloud agents…</span>
          </div>
        ) : problem ? (
          <div className="rounded-md border border-red-400/20 bg-red-500/[0.06] px-2.5 py-2 text-[11.5px] leading-relaxed text-red-200/85">
            {problem}
          </div>
        ) : null}

        {entry ? (
          <div className="space-y-4">
            {/* The facts block: the compiled row expansion, one fact per line. */}
            <div className="space-y-1 font-mono text-[10px] text-fg/40">
              <div>agent {entry.agent.agentId.slice(0, 14)}…</div>
              {entry.latestRunId ? <div>run {entry.latestRunId.slice(0, 14)}…</div> : null}
              {entry.branch ? <div>branch {entry.branch}</div> : null}
              {entry.modelId ? <div>model {entry.modelId}</div> : null}
              {entry.ownership.laneName ? <div>lane {entry.ownership.laneName}</div> : null}
              {page?.usage?.totalTokens != null ? (
                <div>
                  tokens {page.usage.totalTokens.toLocaleString()}
                  {page.usage.inputTokens != null
                    ? ` · in ${page.usage.inputTokens.toLocaleString()} out ${page.usage.outputTokens?.toLocaleString() ?? "0"}`
                    : ""}
                </div>
              ) : null}
              {page?.usage?.cost ? <div>cost {page.usage.cost}</div> : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {entry.agent.webUrl ? (
                <button
                  type="button"
                  onClick={() => void openLink(entry.agent.webUrl!)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.07] px-2 font-sans text-[11px] text-fg/60 transition-colors hover:border-white/[0.16] hover:text-fg/85"
                >
                  <ArrowSquareOut size={10} weight="bold" /> cursor.com
                </button>
              ) : null}
              {entry.prUrl ? (
                <button
                  type="button"
                  onClick={() => void openLink(entry.prUrl!)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-violet-300/25 px-2 font-sans text-[11px] text-violet-100/85 transition-colors hover:bg-violet-500/[0.12]"
                  title="Open pull request"
                >
                  <GitPullRequest size={10} weight="bold" /> PR
                </button>
              ) : null}
              {active ? (
                <button
                  type="button"
                  onClick={runStop}
                  disabled={busy}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-red-400/20 bg-red-500/[0.06] px-2 font-sans text-[10.5px] font-medium text-red-200/85 transition-colors hover:bg-red-500/[0.12] disabled:opacity-40"
                  title="Stop this run — works even if it was launched elsewhere"
                >
                  <Stop size={10} weight="fill" /> Stop
                </button>
              ) : null}
            </div>

            {page && page.runs.length > 0 ? (
              <section>
                <span className="font-sans text-[10px] font-semibold uppercase tracking-[1px] text-fg/45">
                  Runs
                </span>
                <div className="mt-1.5 space-y-1.5">
                  {page.runs.map((run) => (
                    <div
                      key={run.runId}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.015] px-2.5 py-1.5 font-mono text-[10px] text-fg/40"
                    >
                      <span className="text-fg/55">{run.runId.slice(0, 14)}…</span>
                      {run.status ? <StatusPill status={run.status} /> : null}
                      {run.modelId ? <span>{run.modelId}</span> : null}
                      {run.branch ? <span className="min-w-0 truncate">{run.branch}</span> : null}
                      {run.age ? <span>{run.age}</span> : null}
                      {run.prUrl ? (
                        <button
                          type="button"
                          onClick={() => void openLink(run.prUrl!)}
                          className="ml-auto inline-flex items-center gap-0.5 text-violet-200/70 hover:text-violet-100"
                          title="Open pull request"
                        >
                          <GitPullRequest size={10} weight="bold" /> PR
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {page && page.artifacts.length > 0 ? (
              <section>
                <span className="font-sans text-[10px] font-semibold uppercase tracking-[1px] text-fg/45">
                  Artifacts
                </span>
                <div className="mt-1.5 space-y-1.5">
                  {page.artifacts.map((artifact) => {
                    const size = artifactSizeLabel(artifact.bytes);
                    return (
                      <div
                        key={artifact.path}
                        className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.015] px-2.5 py-1.5"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg/60">
                          {artifact.path}
                        </span>
                        {size ? <span className="shrink-0 font-mono text-[10px] text-fg/35">{size}</span> : null}
                        {artifact.url ? (
                          <button
                            type="button"
                            /*
                             * The URL is a signed download that expires, and the
                             * page never touches its bytes: the host opens it,
                             * exactly as it opens a PR. A guest fetching it
                             * would need `api.cursor.com` in its own allowlist
                             * and would have nowhere to put the result.
                             */
                            onClick={() => void openLink(artifact.url!)}
                            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-white/[0.07] px-2 font-sans text-[10.5px] text-fg/60 transition-colors hover:border-white/[0.16] hover:text-fg/85"
                          >
                            <ArrowSquareOut size={9} weight="bold" /> Open
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>

      {notice ? (
        <div className="shrink-0 border-t border-white/[0.05] px-4 py-1.5 text-[11px] text-fg/55" role="status">
          {notice}
        </div>
      ) : null}

      {/*
       * The follow-up composer.
       *
       * Drawn always, enabled only while the agent is active — a disabled box
       * with its own reason beats a box that disappears, because "where did the
       * reply field go" is the question a finished run would otherwise raise.
       */}
      <div className="shrink-0 border-t border-white/[0.07] px-4 py-2.5">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submitFollowUp();
              }
            }}
            rows={2}
            disabled={!active || busy}
            aria-label="Follow-up prompt"
            placeholder={active ? "Send another turn to this agent…" : "This agent is no longer running."}
            className="min-h-[44px] w-full flex-1 resize-y rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 font-sans text-[11.5px] text-fg/85 outline-none transition-colors placeholder:text-fg/30 hover:border-white/[0.16] focus:border-violet-300/35 disabled:opacity-40"
          />
          <button
            type="button"
            onClick={submitFollowUp}
            disabled={!active || busy || draft.trim().length === 0}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-violet-300/25 bg-violet-500/[0.10] px-2.5 font-sans text-[11px] font-semibold text-violet-100/90 transition-colors",
              "hover:border-violet-300/40 hover:bg-violet-500/[0.18] disabled:opacity-40",
            )}
          >
            <PaperPlaneRight size={11} weight="bold" /> Send
          </button>
        </div>
      </div>
    </div>
  );
}
