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
 * page: a path, a size and a press that hands the signed URL to the host. It
 * is a DISCLOSURE rather than a list, because the links are minted per file and
 * minting fifty of them for a section nobody opened is fifty requests spent on
 * nothing.
 *
 * ## Why it never draws the agent before last
 *
 * The pane's `agentId` changes under it — the fleet keeps ONE mounted and hands
 * it the selected id — so every piece of state here belongs to an id, and the
 * moment the id changes all of it is wrong. Three things keep the pane honest:
 *
 * - the state resets in the RENDER that first sees a new id, so no frame is
 *   ever painted with the last agent's runs, usage or artifacts;
 * - `initialEntry` is the row the fleet already has, so the header paints the
 *   right name, status and age immediately rather than after `pageAgent`;
 * - the generation guard drops an answer for an id that is no longer shown.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  CircleNotch,
  GitPullRequest,
  PaperPlaneRight,
  Stop,
  X,
} from "@phosphor-icons/react";
import { cn } from "@ade-dev/ui";

import type { CloudAgentPage, CloudFleetEntry, CloudUsage } from "../types";
import { followUp as sendFollowUp, getArtifactUrls, stopRun } from "../host/actions";
import { AGENT_PAGE_FRESH_MS, cachedAgentPage, fetchAgentPage } from "../host/agentPageCache";
import { openLink } from "../host/ui";
import { useHostRefresh } from "../host/refresh";
import { useCollectionChanges } from "../host/useHostEntities";
import { artifactSizeLabel } from "../lib/cursorCloud";
import { StatusPill } from "./FleetRow";

export function AgentDetail({
  agentId,
  initialEntry,
  onClose,
  onUsage,
  onChanged,
}: {
  agentId: string;
  /**
   * The fleet's own row for this agent, when the fleet is what opened the pane.
   *
   * It is not a shortcut: it is the difference between a pane that names the
   * agent the reader just clicked and a pane that names the previous one until
   * the network answers. `pageAgent` still runs, and its `entry` replaces this
   * the moment it lands — including replacing it with NOTHING, which is how an
   * agent deleted on cursor.com still reaches its "not in this fleet" sentence.
   */
  initialEntry?: CloudFleetEntry | null;
  /** Given by the fleet, absent on the standalone surface, which has no pane to close. */
  onClose?: () => void;
  /** Hands the usage back up so the fleet row can wear its cost chip. */
  onUsage?: (agentId: string, usage: CloudUsage | null) => void;
  /** Something changed on Cursor's side; the fleet should re-read. */
  onChanged?: () => void;
}): React.ReactElement {
  const [page, setPage] = useState<CloudAgentPage | null>(() => cachedAgentPage(agentId));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [artifactUrls, setArtifactUrls] = useState<Record<string, string> | null>(null);
  const [artifactsBusy, setArtifactsBusy] = useState(false);

  /**
   * The id this render's state belongs to.
   *
   * Reset DURING render rather than in an effect: an effect runs after the
   * browser has already been handed a frame, and that frame would carry the
   * previous agent's facts under the new agent's name. React supports exactly
   * this — a `setState` while rendering re-renders the component before it
   * commits anything, and nothing stale is ever painted.
   */
  const [shownAgentId, setShownAgentId] = useState(agentId);
  if (shownAgentId !== agentId) {
    setShownAgentId(agentId);
    setPage(cachedAgentPage(agentId));
    setError(null);
    setBusy(false);
    setDraft("");
    setNotice(null);
    setArtifactsOpen(false);
    setArtifactUrls(null);
    setArtifactsBusy(false);
  }

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

  /**
   * Read this agent, painting whatever is already known first.
   *
   * `fresh` is what every re-read after a mutation or a relay wake passes: the
   * remembered page may answer a first mount, but never a read made BECAUSE
   * something changed.
   */
  const load = useCallback((options: { fresh?: boolean } = {}) => {
    const generation = requestRef.current + 1;
    requestRef.current = generation;
    const known = cachedAgentPage(agentId);
    if (known) {
      setPage(known);
      setError(null);
      usageRef.current?.(agentId, known.usage);
    }
    // A spinner belongs only where there is nothing to look at.
    setLoading(!known);
    void fetchAgentPage(agentId, { maxAgeMs: options.fresh ? 0 : AGENT_PAGE_FRESH_MS })
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
    load();
  }, [load]);

  // Both freshness channels, and no timer: the reader's pull-down, and the
  // child writing the `fleet` collection when a relay delivery lands. Both are
  // news, so both bypass what this page already remembers.
  const reload = useCallback(() => load({ fresh: true }), [load]);
  useHostRefresh(reload);
  useCollectionChanges(reload, "fleet");

  /**
   * Mint every signed download, once, when the section is opened.
   *
   * Re-opening a section already minted asks again only if the last answer had
   * nothing in it: a signed URL expires, but not inside one visit to one pane,
   * and asking on every toggle would be a request per press.
   */
  const toggleArtifacts = useCallback(() => {
    const opening = !artifactsOpen;
    setArtifactsOpen(opening);
    if (!opening || artifactUrls || artifactsBusy) return;
    setArtifactsBusy(true);
    const generation = requestRef.current;
    void getArtifactUrls(agentId)
      .then((answer) => {
        if (requestRef.current !== generation) return;
        const minted: Record<string, string> = {};
        for (const row of answer.urls) if (row.url) minted[row.path] = row.url;
        setArtifactUrls(minted);
      })
      .catch(() => {
        // A mint that failed leaves the paths listed with no download beside
        // them, which is what the row already draws for a file this key cannot
        // sign. It is not worth a banner over the pane.
        if (requestRef.current === generation) setArtifactUrls({});
      })
      .finally(() => {
        if (requestRef.current === generation) setArtifactsBusy(false);
      });
  }, [agentId, artifactUrls, artifactsBusy, artifactsOpen]);

  /**
   * The row the pane draws from: the child's answer once it has one, and the
   * fleet's own row until then. `page` replacing it with a null entry is a
   * fact, not a gap, which is why this is a branch on `page` and not a `??`.
   */
  const entry = page ? page.entry : (initialEntry ?? null);
  const active = entry?.active === true;
  /**
   * Whether another turn can be sent, which is NOT the same as "still running".
   *
   * A follow-up is a new run on an agent that already exists — that is how
   * Cursor spells "keep going", and a finished agent is exactly the one a
   * reader wants to say "now do the tests" to. The only agent that cannot take
   * one is an ARCHIVED agent, so that is what the box gates on. Stop still
   * gates on `active`, because there is nothing to stop otherwise.
   */
  const canFollowUp = entry != null && entry.agent.archived !== true;
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
    ?? (page && !page.entry ? "It is not in this project's fleet." : null);

  const runStop = useCallback(() => {
    setBusy(true);
    setNotice(null);
    void stopRun(agentId)
      .then((result) => {
        setNotice(result.message ?? null);
        if (result.ok) {
          load({ fresh: true });
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
    if (!prompt || !canFollowUp) return;
    setBusy(true);
    setNotice(null);
    void sendFollowUp(agentId, prompt)
      .then((result) => {
        setNotice(result.message ?? null);
        if (result.ok) {
          setDraft("");
          load({ fresh: true });
          onChanged?.();
        }
      })
      .catch((err: unknown) => {
        setNotice(err instanceof Error ? err.message : "Could not send that to Cursor Cloud.");
      })
      .finally(() => setBusy(false));
  }, [agentId, canFollowUp, draft, load, onChanged]);

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
        {loading && !page && !entry ? (
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
                {/*
                 * A disclosure, not a list. Opening it is what mints the signed
                 * downloads, in one call for every file — see `toggleArtifacts`.
                 */}
                <button
                  type="button"
                  onClick={toggleArtifacts}
                  aria-expanded={artifactsOpen}
                  className="flex w-full items-center gap-1.5 font-sans text-[10px] font-semibold uppercase tracking-[1px] text-fg/45 transition-colors hover:text-fg/70"
                >
                  {artifactsOpen
                    ? <CaretDown size={9} weight="bold" />
                    : <CaretRight size={9} weight="bold" />}
                  Artifacts ({page.artifacts.length})
                  {artifactsBusy ? (
                    <CircleNotch size={10} weight="bold" className="animate-spin" />
                  ) : null}
                </button>
                {artifactsOpen ? (
                  <div className="mt-1.5 space-y-1.5">
                    {page.artifacts.map((artifact) => {
                      const size = artifactSizeLabel(artifact.bytes);
                      const url = artifact.url ?? artifactUrls?.[artifact.path] ?? null;
                      return (
                        <div
                          key={artifact.path}
                          className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.015] px-2.5 py-1.5"
                        >
                          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg/60">
                            {artifact.path}
                          </span>
                          {size ? <span className="shrink-0 font-mono text-[10px] text-fg/35">{size}</span> : null}
                          {url ? (
                            <button
                              type="button"
                              /*
                               * The URL is a signed download that expires, and
                               * the page never touches its bytes: the host opens
                               * it, exactly as it opens a PR. A guest fetching it
                               * would need `api.cursor.com` in its own allowlist
                               * and would have nowhere to put the result.
                               */
                              onClick={() => void openLink(url)}
                              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-white/[0.07] px-2 font-sans text-[10.5px] text-fg/60 transition-colors hover:border-white/[0.16] hover:text-fg/85"
                            >
                              <ArrowSquareOut size={9} weight="bold" /> Open
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
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
       * Drawn always, and enabled for every agent that is not archived. A
       * finished agent still takes a follow-up: Cursor has no separate verb for
       * "keep going", so another turn IS another run on the same agent, and
       * "now run the tests" on a run that just finished is the commonest thing
       * a reader wants to say. A disabled box with its own reason beats a box
       * that disappears, because "where did the reply field go" is the question
       * an archived agent would otherwise raise.
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
            disabled={!canFollowUp || busy}
            aria-label="Follow-up prompt"
            placeholder={canFollowUp
              ? "Send another turn to this agent…"
              : "This agent is archived."}
            className="min-h-[44px] w-full flex-1 resize-y rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 font-sans text-[11.5px] text-fg/85 outline-none transition-colors placeholder:text-fg/30 hover:border-white/[0.16] focus:border-violet-300/35 disabled:opacity-40"
          />
          <button
            type="button"
            onClick={submitFollowUp}
            disabled={!canFollowUp || busy || draft.trim().length === 0}
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
