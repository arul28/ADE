import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check, MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import type { LaneBranchActiveWorkItem, LaneSummary } from "../../../../shared/types";
import { useClampedFixedPosition, type FixedAnchor } from "../../../hooks/useClampedFixedPosition";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { useAppStore } from "../../../state/appStore";
import { BranchIcon } from "../../ui/vcsIcons";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, outlineButton } from "../laneDesignTokens";
import {
  formatBranchCheckoutError,
  stripRemotePrefix,
  validateBranchName,
  type LaneBranchOption,
} from "../laneUtils";
import { laneBranchLabel } from "../sidebar/laneSidebarModel";

type PendingBranchSwitch = {
  branchName: string;
  mode: "existing" | "create";
  startPoint?: string;
  baseRef?: string;
  activeWork: LaneBranchActiveWorkItem[];
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  maxWidth: "100%",
  height: 30,
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  background: "rgba(255,255,255,0.04)",
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 6,
  padding: "0 8px",
  boxSizing: "border-box",
  textOverflow: "ellipsis",
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontFamily: MONO_FONT,
  fontWeight: 700,
  letterSpacing: "1px",
  color: COLORS.textDim,
};

/**
 * Branch dropdown for the selected lane: switch the lane's worktree to another
 * local or remote branch, or create a new branch in place. Branches load only
 * while the dropdown is open.
 */
export function LaneBranchSwitcher({
  lane,
  primaryLane,
  active,
}: {
  lane: LaneSummary;
  primaryLane: LaneSummary | null;
  active: boolean;
}) {
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<LaneBranchOption[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [newBranchStartPoint, setNewBranchStartPoint] = useState("");
  const [newBranchBaseRef, setNewBranchBaseRef] = useState("");
  const [newBranchFormOpen, setNewBranchFormOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<PendingBranchSwitch | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Where the menu opens: just under the trigger, in viewport pixels.
  const [anchor, setAnchor] = useState<FixedAnchor | null>(null);
  const { ref: menuRef, position: menuPosition } = useClampedFixedPosition(
    open ? anchor : null,
    `${branches.length}:${newBranchFormOpen}:${pendingSwitch?.branchName ?? ""}:${branchesLoading}`,
  );

  const toggleOpen = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.left, y: rect.bottom + 4 });
    setOpen((prev) => !prev);
  }, []);

  // The menu lives in a portal, so clicks inside it are not inside rootRef.
  const insideMenu = useCallback((target: Node) => menuRef.current?.contains(target) ?? false, [menuRef]);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(rootRef, close, open, insideMenu);

  // A fixed menu would drift away from its trigger, so close it when the
  // page scrolls or the window resizes. Scrolling the branch list is fine.
  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close, menuRef]);

  // Clear stale results whenever the lane changes, or lane A's branches would
  // linger in lane B's dropdown until the new fetch resolves.
  useEffect(() => {
    setError(null);
  }, [lane.id]);

  useEffect(() => {
    setBranches([]);
    if (!active || !open) return;
    let cancelled = false;
    setBranchesLoading(true);
    window.ade.git.listBranches({ laneId: lane.id })
      .then((result) => { if (!cancelled) setBranches(result); })
      .catch(() => { if (!cancelled) setBranches([]); })
      .finally(() => { if (!cancelled) setBranchesLoading(false); });
    return () => { cancelled = true; };
  }, [active, open, lane.id]);

  // Someone switched branches outside ADE: bring the lane list up to date.
  useEffect(() => {
    if (!active) return;
    const current = branches.find((branch) => branch.isCurrent && !branch.isRemote)?.name ?? null;
    if (!current || current === lane.branchRef) return;
    refreshLanes().catch(() => {});
  }, [active, branches, lane.branchRef, refreshLanes]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setPendingSwitch(null);
    setNewBranchStartPoint("");
    setNewBranchBaseRef("");
    setNewBranchName("");
    setNewBranchFormOpen(false);
    const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, lane.id]);

  const localBranches = useMemo(() => {
    const q = query.toLowerCase();
    return branches.filter((branch) => !branch.isRemote && (!q || branch.name.toLowerCase().includes(q)));
  }, [branches, query]);
  const remoteBranches = useMemo(() => {
    const q = query.toLowerCase();
    return branches.filter((branch) => branch.isRemote && (!q || branch.name.toLowerCase().includes(q)));
  }, [branches, query]);
  const startPointOptions = useMemo(() => {
    type StartOption = { value: string; label: string };
    const map = new Map<string, StartOption>();
    if (lane.branchRef) map.set(lane.branchRef, { value: lane.branchRef, label: lane.branchRef });
    for (const branch of branches) {
      if (branch.isRemote || map.has(branch.name)) continue;
      map.set(branch.name, { value: branch.name, label: branch.name });
    }
    for (const branch of branches) {
      if (!branch.isRemote || map.has(stripRemotePrefix(branch.name)) || map.has(branch.name)) continue;
      map.set(branch.name, { value: branch.name, label: `${branch.name} (remote)` });
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [lane.branchRef, branches]);
  const baseRefOptions = useMemo(() => {
    const names = new Set<string>();
    if (primaryLane?.branchRef) names.add(primaryLane.branchRef);
    for (const option of startPointOptions) names.add(option.value);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [startPointOptions, primaryLane?.branchRef]);
  const nameValidation = useMemo(
    () => (newBranchName.trim() ? validateBranchName(newBranchName) : { ok: false as const, reason: undefined }),
    [newBranchName],
  );

  const checkout = useCallback(async (request: {
    branchName: string;
    mode?: "existing" | "create";
    startPoint?: string;
    baseRef?: string;
    acknowledgeActiveWork?: boolean;
  }) => {
    if (lane.status.dirty) {
      setError(`Cannot switch branches while ${lane.name} has uncommitted changes. Commit, stash, or discard changes first.`);
      return;
    }
    const mode = request.mode ?? "existing";
    const branchName = request.branchName.trim();
    if (!branchName) return;
    setBusy(true);
    setError(null);
    let succeeded = false;
    try {
      if (!request.acknowledgeActiveWork) {
        const preview = await window.ade.lanes.previewBranchSwitch({
          laneId: lane.id,
          branchName,
          mode,
          startPoint: request.startPoint,
          baseRef: request.baseRef,
        });
        if (preview.duplicateLaneId) {
          throw new Error(`Branch '${preview.targetBranchRef}' is already active in ${preview.duplicateLaneName ?? "another lane"}.`);
        }
        if (preview.dirty) {
          throw new Error(`Cannot switch branches while ${lane.name} has uncommitted changes.`);
        }
        if (preview.activeWork.length > 0) {
          setPendingSwitch({ branchName, mode, startPoint: request.startPoint, baseRef: request.baseRef, activeWork: preview.activeWork });
          return;
        }
      }
      await window.ade.git.checkoutBranch({
        laneId: lane.id,
        branchName,
        mode,
        startPoint: request.startPoint,
        baseRef: request.baseRef,
        acknowledgeActiveWork: request.acknowledgeActiveWork,
      });
      await refreshLanes();
      setBranches(await window.ade.git.listBranches({ laneId: lane.id }));
      setPendingSwitch(null);
      setNewBranchName("");
      succeeded = true;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(formatBranchCheckoutError(raw, lane.name));
    } finally {
      setBusy(false);
      if (succeeded) setOpen(false);
    }
  }, [lane, refreshLanes]);

  const branchRow = (branch: LaneBranchOption, kind: "local" | "remote") => {
    const owned = Boolean(branch.ownedByLaneId);
    const current = kind === "local" && branch.isCurrent;
    return (
      <button
        key={`${kind}:${branch.name}`}
        type="button"
        className="flex w-full items-center gap-2 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]"
        style={{
          padding: "6px 12px",
          fontSize: 12,
          fontFamily: MONO_FONT,
          color: current ? COLORS.success : COLORS.textMuted,
          fontWeight: current ? 600 : 400,
          cursor: current || owned ? "not-allowed" : "pointer",
          opacity: owned ? 0.6 : 1,
        }}
        disabled={busy || current || owned}
        title={owned ? `Already active in ${branch.ownedByLaneName ?? "another lane"}` : undefined}
        onClick={() => { void checkout({ branchName: branch.name }); }}
      >
        {current ? <Check size={12} className="shrink-0" /> : <span className="shrink-0" style={{ width: 12 }} />}
        <span className="truncate">{branch.name}</span>
        {branch.ownedByLaneName ? (
          <span className="ml-auto shrink-0" style={{ fontSize: 11, color: COLORS.warning }}>in {branch.ownedByLaneName}</span>
        ) : kind === "remote" ? (
          <span className="ml-auto shrink-0" style={{ fontSize: 11, color: COLORS.info }}>remote</span>
        ) : branch.upstream ? (
          <span className="ml-auto shrink-0" style={{ fontSize: 11, color: COLORS.textDim }}>tracked</span>
        ) : null}
      </button>
    );
  };

  return (
    <div className="relative flex min-w-0 shrink items-center" ref={rootRef}>
      <button
        type="button"
        data-tour="lanes.branchSelector"
        className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] transition-colors hover:bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]"
        style={{ color: COLORS.textSecondary }}
        ref={triggerRef}
        onClick={toggleOpen}
        disabled={busy}
        title={`Switch ${lane.name} to another branch`}
      >
        <BranchIcon size={12} className="shrink-0 opacity-70" />
        <span className="truncate">{laneBranchLabel(lane.branchRef)}</span>
        <CaretDown size={10} className="shrink-0 opacity-60" />
      </button>
      {error && !open ? (
        <span className="ml-2 inline-flex min-w-0 items-center gap-1 text-[11px]" style={{ color: COLORS.danger }} title={error}>
          <span className="truncate">{error}</span>
          <button type="button" className="shrink-0" onClick={() => setError(null)} aria-label="Dismiss">
            <X size={10} />
          </button>
        </span>
      ) : null}
      {/* Portaled to the body so the lane header and panes cannot clip it. */}
      {open && anchor ? createPortal(
        <div
          ref={menuRef}
          className="ade-liquid-glass-menu flex flex-col overflow-hidden"
          style={{
            position: "fixed",
            zIndex: 200,
            left: menuPosition?.left ?? anchor.x,
            top: menuPosition?.top ?? anchor.y,
            visibility: menuPosition ? "visible" : "hidden",
            maxHeight: "min(480px, calc(100vh - 16px))",
            width: 360,
            padding: "4px 0",
            border: `1px solid ${COLORS.outlineBorder}`,
            background: COLORS.cardBgSolid,
            boxShadow: "0 24px 56px -20px rgba(0, 0, 0, 0.7)",
          }}
        >
          <div className="relative shrink-0" style={{ padding: "4px 8px" }}>
            <MagnifyingGlass size={13} className="pointer-events-none absolute" style={{ left: 16, top: "50%", transform: "translateY(-50%)", color: COLORS.textDim }} />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search branches…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
              style={{ ...fieldStyle, height: "auto", padding: "5px 8px 5px 28px", outline: "none" }}
            />
          </div>
          {newBranchFormOpen ? (
            <div style={{ padding: "8px 10px", borderTop: `1px solid ${COLORS.border}`, borderBottom: `1px solid ${COLORS.border}` }}>
              <div style={{ display: "grid", gap: 8 }}>
                <div className="flex items-center justify-between">
                  <div style={fieldLabelStyle}>NEW BRANCH</div>
                  <button
                    type="button"
                    onClick={() => { setNewBranchFormOpen(false); setNewBranchName(""); }}
                    style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}
                  >
                    Cancel
                  </button>
                </div>
                <input
                  type="text"
                  placeholder="feature/short-name"
                  value={newBranchName}
                  onChange={(event) => setNewBranchName(event.target.value)}
                  aria-invalid={Boolean(newBranchName.trim()) && !nameValidation.ok}
                  autoFocus
                  style={{
                    ...fieldStyle,
                    outline: "none",
                    borderColor: newBranchName.trim() && !nameValidation.ok ? COLORS.danger : COLORS.outlineBorder,
                  }}
                />
                {newBranchName.trim() && nameValidation.reason ? (
                  <div style={{ fontSize: 11, color: COLORS.danger }}>{nameValidation.reason}</div>
                ) : null}
                <label className="flex flex-col gap-1">
                  <span style={fieldLabelStyle}>START FROM</span>
                  <select
                    value={newBranchStartPoint || lane.branchRef}
                    onChange={(event) => setNewBranchStartPoint(event.target.value)}
                    style={fieldStyle}
                  >
                    {startPointOptions.map((option) => <option key={`start:${option.value}`} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1" title="ADE compares this lane against this base for rebase and merge readiness.">
                  <span style={fieldLabelStyle}>REBASE BASE</span>
                  <select
                    value={newBranchBaseRef || primaryLane?.branchRef || lane.baseRef}
                    onChange={(event) => setNewBranchBaseRef(event.target.value)}
                    style={fieldStyle}
                  >
                    {baseRefOptions.map((name) => <option key={`base:${name}`} value={name}>{name}</option>)}
                  </select>
                </label>
                <button
                  type="button"
                  className="flex w-full items-center justify-center gap-2"
                  style={{
                    height: 30,
                    border: `1px solid ${COLORS.outlineBorder}`,
                    borderRadius: 6,
                    background: "rgba(255,255,255,0.05)",
                    color: COLORS.textPrimary,
                    fontSize: 12,
                    fontFamily: SANS_FONT,
                    cursor: nameValidation.ok && !busy ? "pointer" : "not-allowed",
                    opacity: nameValidation.ok && !busy ? 1 : 0.5,
                  }}
                  disabled={busy || !nameValidation.ok}
                  onClick={() => {
                    void checkout({
                      branchName: newBranchName,
                      mode: "create",
                      startPoint: newBranchStartPoint || lane.branchRef,
                      baseRef: newBranchBaseRef || primaryLane?.branchRef || lane.baseRef,
                    });
                  }}
                >
                  <Plus size={13} />
                  <span>Create in this lane</span>
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]"
              onClick={() => setNewBranchFormOpen(true)}
              style={{
                padding: "8px 12px",
                borderTop: `1px solid ${COLORS.border}`,
                borderBottom: `1px solid ${COLORS.border}`,
                color: COLORS.textSecondary,
                fontSize: 12,
                fontFamily: SANS_FONT,
              }}
            >
              <Plus size={13} />
              <span>New branch…</span>
            </button>
          )}
          {pendingSwitch ? (
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${COLORS.border}`, background: "color-mix(in srgb, var(--color-warning) 12%, transparent)" }}>
              <div style={{ fontSize: 12, color: COLORS.textPrimary, fontWeight: 600 }}>This lane has active work.</div>
              <div style={{ marginTop: 2, fontSize: 11, color: COLORS.textMuted }}>Terminals stay attached and keep running on the new branch.</div>
              <div style={{ marginTop: 6, display: "grid", gap: 2 }}>
                {pendingSwitch.activeWork.slice(0, 3).map((item) => (
                  <div key={`${item.kind}:${item.id}`} className="truncate" style={{ fontSize: 11, color: COLORS.textSecondary }}>
                    Terminal: {item.title}
                  </div>
                ))}
                {pendingSwitch.activeWork.length > 3 ? (
                  <div style={{ fontSize: 11, color: COLORS.textDim }}>+ {pendingSwitch.activeWork.length - 3} more</div>
                ) : null}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  style={{
                    fontSize: 11,
                    padding: "4px 8px",
                    height: 26,
                    border: `1px solid ${COLORS.warning}`,
                    borderRadius: 6,
                    background: "color-mix(in srgb, var(--color-warning) 25%, transparent)",
                    color: COLORS.warning,
                    fontFamily: SANS_FONT,
                    fontWeight: 600,
                  }}
                  onClick={() => { void checkout({ ...pendingSwitch, acknowledgeActiveWork: true }); }}
                >
                  Switch anyway
                </button>
                <button
                  type="button"
                  style={outlineButton({ fontSize: 11, padding: "4px 8px", height: 26 })}
                  onClick={() => setPendingSwitch(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          <div className="flex-1 overflow-auto" style={{ padding: "2px 0" }}>
            {branchesLoading && branches.length === 0 ? (
              <div style={{ padding: "10px 12px", fontSize: 12, color: COLORS.textMuted }}>Loading branches…</div>
            ) : null}
            <div style={{ padding: "6px 12px", ...LABEL_STYLE }}>Local branches</div>
            {localBranches.map((branch) => branchRow(branch, "local"))}
            {remoteBranches.length > 0 ? (
              <>
                <div style={{ margin: "4px 0", height: 1, background: COLORS.border }} />
                <div style={{ padding: "6px 12px", ...LABEL_STYLE }}>Remote branches</div>
                {remoteBranches.map((branch) => branchRow(branch, "remote"))}
              </>
            ) : null}
            {!branchesLoading && localBranches.length === 0 && remoteBranches.length === 0 ? (
              <div style={{ padding: "6px 12px", fontSize: 12, color: COLORS.textMuted }}>{query ? "No matching branches." : "No branches found."}</div>
            ) : null}
            {error ? (
              <div style={{ padding: "6px 12px", fontSize: 11, color: COLORS.danger }}>{error}</div>
            ) : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
