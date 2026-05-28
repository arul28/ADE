import React, { useCallback, useEffect, useRef, useState } from "react";
import { CircleNotch, GitFork, WarningCircle, Check } from "@phosphor-icons/react";
import type { UnregisteredLaneCandidate } from "../../../shared/types/lanes";
import { COLORS, SANS_FONT, MONO_FONT } from "../lanes/laneDesignTokens";
import { Button } from "../ui/Button";
import { RescanButton } from "./RescanButton";
import { CARD_BASE, SECTION_LABEL } from "./onboardingTheme";

type LoadOptions = { preselectAll?: boolean; keepSelected?: Set<string> };

export function WorktreesCard() {
  const [worktrees, setWorktrees] = useState<UnregisteredLaneCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attaching, setAttaching] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [errors, setErrors] = useState<string[]>([]);
  const [importedCount, setImportedCount] = useState(0);

  const load = useCallback(async (opts: LoadOptions = {}) => {
    setLoading(true);
    setFetchError(null);
    try {
      const result = await window.ade.lanes.listUnregisteredWorktrees();
      setWorktrees(result);
      if (opts.keepSelected) {
        const keep = opts.keepSelected;
        setSelected(new Set(result.filter((wt) => keep.has(wt.path)).map((wt) => wt.path)));
      } else if (opts.preselectAll) {
        setSelected(new Set(result.map((wt) => wt.path)));
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load({ preselectAll: true });
  }, [load]);

  const allSelected = selected.size === worktrees.length && worktrees.length > 0;
  const someSelected = selected.size > 0 && selected.size < worktrees.length;

  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(worktrees.map((wt) => wt.path)));
  };

  const toggleOne = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleImport = async () => {
    const toAttach = worktrees.filter((wt) => selected.has(wt.path));
    if (toAttach.length === 0) return;
    setAttaching(true);
    setErrors([]);
    const collectedErrors: string[] = [];
    const failedPaths = new Set<string>();
    let ok = 0;
    for (let i = 0; i < toAttach.length; i++) {
      const wt = toAttach[i]!;
      setProgress({ current: i + 1, total: toAttach.length });
      try {
        const name = wt.branch || wt.path.split("/").pop() || "worktree";
        await window.ade.lanes.attach({ name, attachedPath: wt.path });
        ok += 1;
      } catch (err) {
        failedPaths.add(wt.path);
        collectedErrors.push(
          `${wt.branch || wt.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    setErrors(collectedErrors);
    setImportedCount((c) => c + ok);
    setAttaching(false);
    // Drop the worktrees that became lanes; keep failures selected for an easy retry.
    await load({ keepSelected: failedPaths });
  };

  const busy = loading || attaching;
  const importLabel = attaching
    ? `Adding ${progress.current}/${progress.total}…`
    : `Add ${selected.size} as lane${selected.size !== 1 ? "s" : ""}`;

  return (
    <section style={CARD_BASE}>
      <div style={sectionHeader}>
        <span style={SECTION_LABEL}>Add existing worktrees</span>
        <RescanButton loading={busy} onClick={() => void load({ preselectAll: true })} />
      </div>

      {loading ? (
        <div style={stateRow}>
          <CircleNotch size={15} className="animate-spin" />
          <span>Scanning for worktrees…</span>
        </div>
      ) : fetchError ? (
        <div style={{ ...stateRow, color: COLORS.danger, alignItems: "flex-start" }}>
          <WarningCircle size={15} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>{fetchError}</span>
        </div>
      ) : worktrees.length === 0 ? (
        <div style={emptyStateStyle}>
          {importedCount > 0 ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: COLORS.success }}>
              <Check size={14} weight="bold" />
              Added {importedCount} worktree{importedCount !== 1 ? "s" : ""} as lane{importedCount !== 1 ? "s" : ""}. Nothing left to import.
            </span>
          ) : (
            "No worktrees outside ADE. Worktrees you create elsewhere show up here, ready to import as lanes."
          )}
        </div>
      ) : (
        <>
          <p style={subtitleStyle}>
            {worktrees.length} git worktree{worktrees.length !== 1 ? "s" : ""} found outside ADE. Bring them in as lanes.
          </p>
          <div style={selectAllRow}>
            <label style={selectAllLabel}>
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                disabled={attaching}
              />
              Select all
            </label>
            <span style={countStyle}>{selected.size} selected</span>
          </div>

          <div style={listStyle}>
            {worktrees.map((wt) => (
              <label key={wt.path} style={rowStyle}>
                <input
                  type="checkbox"
                  style={{ marginTop: 3, flexShrink: 0 }}
                  checked={selected.has(wt.path)}
                  onChange={() => toggleOne(wt.path)}
                  disabled={attaching}
                />
                <GitFork size={14} weight="duotone" style={{ marginTop: 2, color: COLORS.textMuted, flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={branchStyle}>{wt.branch || "(detached HEAD)"}</div>
                  <div style={pathStyle}>{wt.path}</div>
                </div>
              </label>
            ))}
          </div>

          {importedCount > 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: COLORS.success, fontSize: 11, fontFamily: SANS_FONT }}>
              <Check size={13} weight="bold" />
              Added {importedCount} as lane{importedCount !== 1 ? "s" : ""}
            </div>
          ) : null}

          <div style={importRow}>
            <Button
              size="md"
              variant="primary"
              disabled={selected.size === 0 || busy}
              onClick={() => void handleImport()}
            >
              {importLabel}
            </Button>
          </div>
        </>
      )}

      {errors.length > 0 ? (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {errors.map((err, i) => (
            <div key={i} style={errorRow}>
              <WarningCircle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
              <span>{err}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

const sectionHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 6,
  gap: 8,
};

const subtitleStyle: React.CSSProperties = {
  margin: "0 0 14px",
  fontSize: 12,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  lineHeight: 1.5,
};

const countStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  whiteSpace: "nowrap",
};

const stateRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginTop: 8,
  fontSize: 12.5,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
};

const emptyStateStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  lineHeight: 1.55,
};

const selectAllRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 8,
  gap: 8,
};

const selectAllLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  fontFamily: SANS_FONT,
  color: COLORS.textSecondary,
  cursor: "pointer",
  userSelect: "none",
};

const listStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  maxHeight: 260,
  overflowY: "auto",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 10,
  cursor: "pointer",
  minWidth: 0,
};

const branchStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const pathStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: MONO_FONT,
  color: COLORS.textDim,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const importRow: React.CSSProperties = {
  marginTop: 14,
  display: "flex",
  justifyContent: "flex-end",
};

const errorRow: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  fontSize: 11.5,
  fontFamily: SANS_FONT,
  color: COLORS.danger,
  lineHeight: 1.45,
};
