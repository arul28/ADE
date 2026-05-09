import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleNotch, X } from "@phosphor-icons/react";

import type {
  CtoLinearQuickView,
  LaneLinearIssue,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { linearIssueBranchName, linearIssueLaneName } from "../../../shared/linearIssueBranch";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { LinearMark, LINEAR_BRAND } from "../lanes/linearBrand";
import { LinearIssueBrowser, linearBrowserIssueToLaneIssue } from "./LinearIssueBrowser";

type PopoverPosition = { top: number; right: number } | null;

export function LinearQuickViewButton() {
  const project = useAppStore((s) => s.project);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const selectLane = useAppStore((s) => s.selectLane);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition>(null);
  const [quickView, setQuickView] = useState<CtoLinearQuickView | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [creatingIssueId, setCreatingIssueId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setVisible(false);
    setOpen(false);
    setQuickView(null);
    if (!project?.rootPath || !window.ade.cto?.getLinearConnectionStatus) return;
    void window.ade.cto.getLinearConnectionStatus()
      .then((status) => {
        if (!cancelled) setVisible(status.connected === true);
      })
      .catch(() => {
        if (!cancelled) setVisible(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.rootPath]);

  const openAtButton = useCallback(() => {
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition({ top: rect.bottom + 7, right: Math.max(8, window.innerWidth - rect.right) });
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [close, open]);

  const createLaneForIssue = useCallback(async (issue: NormalizedLinearIssue | LaneLinearIssue) => {
    const laneIssue = linearBrowserIssueToLaneIssue(issue);
    const name = linearIssueLaneName(laneIssue);
    const branchName = linearIssueBranchName(laneIssue);
    setCreatingIssueId(laneIssue.id);
    try {
      const lane = await window.ade.lanes.create({
        name,
        branchName,
        linearIssue: { ...laneIssue, branchName },
      });
      await refreshLanes({ includeStatus: false }).catch(() => undefined);
      selectLane(lane.id);
      close();
      window.location.hash = `#/lanes?laneId=${encodeURIComponent(lane.id)}&focus=single`;
    } finally {
      setCreatingIssueId(null);
    }
  }, [close, refreshLanes, selectLane]);

  if (!visible) return null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Linear quick view"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Linear quick view"
        className={cn(
          "ade-shell-control inline-flex h-[20px] w-[20px] items-center justify-center",
          "transition-[background-color,color,border-color,box-shadow] duration-150",
        )}
        data-state={open ? "open" : undefined}
        onClick={() => (open ? close() : openAtButton())}
        style={{
          WebkitAppRegion: "no-drag",
          color: open ? LINEAR_BRAND.primaryBright : undefined,
        } as React.CSSProperties}
      >
        <LinearMark size={13} />
      </button>

      {open && position ? createPortal(
        <>
          <button
            type="button"
            aria-label="Close Linear quick view backdrop"
            data-linear-quick-view-backdrop="true"
            className="fixed inset-0 z-[9998] cursor-default bg-black/30 backdrop-blur-sm"
            onClick={close}
            tabIndex={-1}
          />
          <div
            ref={popoverRef}
            role="dialog"
            aria-modal="false"
            aria-label="Linear quick view"
            className="fixed z-[9999] w-[min(1040px,calc(100vw-24px))] overflow-y-auto rounded-xl border bg-[color:var(--ade-shell-surface,#121019)] text-fg shadow-2xl shadow-black/50"
            style={{
              top: position.top,
              right: position.right,
              maxHeight: "min(760px, calc(100vh - 64px))",
              borderColor: "rgba(123, 138, 240, 0.55)",
              boxShadow: "0 24px 70px rgba(0, 0, 0, 0.58), 0 0 0 1px rgba(123, 138, 240, 0.18)",
            }}
          >
            <div
              className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3"
              style={{ background: LINEAR_BRAND.surface }}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                  style={{ background: LINEAR_BRAND.surfaceHover, color: LINEAR_BRAND.primaryBright }}
                >
                  <LinearMark size={17} />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold">
                    {quickView?.organization?.name ?? "Linear"}
                  </div>
                  <div className="truncate text-[11px] text-muted-fg/65">
                    {quickView?.viewer?.displayName ?? quickView?.connection.viewerName ?? "Connected"}
                    {quickView?.organization?.urlKey ? ` · ${quickView.organization.urlKey}` : ""}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="ade-shell-control inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px]"
                  data-variant="ghost"
                  onClick={() => setRefreshKey((key) => key + 1)}
                  disabled={browserLoading}
                  title="Refresh Linear"
                >
                  {browserLoading ? <CircleNotch size={12} className="animate-spin" /> : null}
                  Refresh
                </button>
                <button
                  type="button"
                  className="ade-shell-control inline-flex h-7 w-7 items-center justify-center rounded-md"
                  data-variant="ghost"
                  onClick={close}
                  title="Close Linear"
                >
                  <X size={13} />
                </button>
              </div>
            </div>

            <LinearIssueBrowser
              projectRoot={project?.rootPath}
              actionLabel="Create lane"
              actionBusyLabel="Creating lane"
              actionBusyIssueId={creatingIssueId}
              refreshKey={refreshKey}
              onIssueAction={createLaneForIssue}
              onConnectionVisibilityChange={setVisible}
              onQuickViewChange={setQuickView}
              onLoadingChange={setBrowserLoading}
            />
          </div>
        </>,
        document.body,
      ) : null}
    </>
  );
}
