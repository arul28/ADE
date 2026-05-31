import React, { useEffect, useState } from "react";
import type { FileDiff, FilePatch, GitCommitSummary } from "../../../../../shared/types";
import { COLORS, MONO_FONT } from "../../../lanes/laneDesignTokens";
import { AdeDiffViewer } from "../../../shared/AdeDiffViewer";

type DiffMode = "unstaged" | "staged" | "commit";

function diffHasChanges(diff: FileDiff | null): boolean {
  if (!diff) return false;
  if (diff.original.exists !== diff.modified.exists) return true;
  if (diff.isBinary) return true;
  return diff.original.text !== diff.modified.text;
}

function patchHasChanges(patch: FilePatch | null): patch is FilePatch {
  if (!patch) return false;
  if (patch.isBinary) return true;
  return patch.patch.trim().length > 0;
}

/**
 * Per-file diff view: compares the file against the working tree / staged index /
 * a chosen commit, reusing the shared AdeDiffViewer + the same diff IPC the rest
 * of ADE uses. Only meaningful inside a lane worktree (needs a laneId).
 */
export function DiffViewer({
  laneId,
  path,
  theme,
}: {
  laneId: string;
  path: string;
  theme: "light" | "dark";
}) {
  const [mode, setMode] = useState<DiffMode>("unstaged");
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [patch, setPatch] = useState<FilePatch | null>(null);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [compareRef, setCompareRef] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.ade.git
      .listRecentCommits({ laneId, limit: 30 })
      .then((rows) => {
        if (cancelled) return;
        setCommits(rows);
        setCompareRef(rows[0]?.sha ?? "");
      })
      .catch(() => {
        if (!cancelled) {
          setCommits([]);
          setCompareRef("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [laneId]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      if (mode === "commit" && !compareRef.trim()) {
        setDiff(null);
        setPatch(null);
        return;
      }
      const args = { laneId, path, mode, compareRef: mode === "commit" ? compareRef : undefined } as const;
      const [d, p] = await Promise.allSettled([window.ade.diff.getFile(args), window.ade.diff.getFilePatch(args)]);
      if (cancelled) return;
      const nextDiff = d.status === "fulfilled" ? d.value : null;
      const nextPatch = p.status === "fulfilled" && patchHasChanges(p.value) ? p.value : null;
      if (!nextPatch && !diffHasChanges(nextDiff)) {
        if (d.status === "rejected") {
          setError(d.reason instanceof Error ? d.reason.message : String(d.reason));
        }
      }
      setDiff(nextDiff);
      setPatch(nextPatch);
    })().catch((err) => {
      if (!cancelled) {
        setDiff(null);
        setPatch(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [laneId, path, mode, compareRef]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: COLORS.border }}>
        <div className="inline-flex items-center overflow-hidden rounded-md" style={{ border: `1px solid ${COLORS.outlineBorder}` }}>
          {(["unstaged", "staged", "commit"] as const).map((m) => {
            const label = m === "unstaged" ? "Working tree" : m === "staged" ? "Staged" : "Commit";
            const isActive = mode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide"
                style={{ color: isActive ? "var(--color-accent-fg)" : COLORS.textMuted, background: isActive ? COLORS.accent : "transparent" }}
              >
                {label}
              </button>
            );
          })}
        </div>
        {mode === "commit" ? (
          <select
            value={compareRef}
            onChange={(e) => setCompareRef(e.target.value)}
            className="rounded border bg-transparent px-2 py-1 text-xs outline-none"
            style={{ fontFamily: MONO_FONT, borderColor: COLORS.outlineBorder, color: COLORS.textSecondary, maxWidth: 320 }}
          >
            {commits.map((c) => (
              <option key={c.sha} value={c.sha} style={{ background: COLORS.cardBgSolid }}>
                {c.shortSha} — {c.subject}
              </option>
            ))}
          </select>
        ) : null}
        <span className="ml-auto truncate text-xs" style={{ fontFamily: MONO_FONT, color: COLORS.textDim }}>{path}</span>
      </div>
      {error ? (
        <div className="px-3 py-2 text-xs" style={{ fontFamily: MONO_FONT, color: COLORS.danger }}>{error}</div>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1">
        {patchHasChanges(patch) || diffHasChanges(diff) ? (
          <AdeDiffViewer diff={diff} patch={patch} className="h-full" theme={theme} />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-xs" style={{ color: COLORS.textMuted }}>
            No changes for this file.
          </div>
        )}
      </div>
    </div>
  );
}
