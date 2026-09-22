import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IosSimulatorPreviewTarget } from "../../../../../shared/types";
import {
  DRAWER_BUTTON,
  DRAWER_GHOST_BUTTON,
  DRAWER_PRIMARY_BUTTON,
  DrawerMenu,
  Row,
  Subhead,
  SwitchRow,
} from "../drawerPrimitives";
import type { AppleDrawerContext } from "../drawerContext";

export type AppleRenderedPreview = { dataUrl: string; targetLabel: string };

/** Debounce for a save storm: editors write a file several times per keystroke. */
const WATCH_DEBOUNCE_MS = 400;

/** Group targets by source file, keeping file order and each file's preview order. */
export function groupPreviewTargets(targets: readonly IosSimulatorPreviewTarget[]) {
  return targets.map((target) => ({
    value: target.id,
    label: target.title,
    group: target.sourceFile,
  }));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** True when a file-change event names the target's source file. */
export function changeMatchesTarget(changedPath: string, target: IosSimulatorPreviewTarget): boolean {
  const changed = normalizePath(changedPath);
  const candidates = [target.absoluteSourceFile, target.sourceFilePath, target.sourceFile]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map(normalizePath);
  return candidates.some((candidate) => changed === candidate || changed.endsWith(`/${candidate}`) || candidate.endsWith(`/${changed}`));
}

/**
 * §B1's **Preview Lab** group: a target picker grouped by file, Render, and a
 * "Watch file" switch. A render hands the picture to the pane, which swaps its
 * viewport into the `preview` state with the "← Back to device" chip; nothing
 * is drawn here. Workspace actions live under the `⋯`, which the drawer hangs
 * in this group's header.
 *
 * The group's `⋯` is exported separately from its body because the card's
 * header owns the right-hand slot: a menu rendered inside the body would sit
 * under the rows it acts on rather than on the card it belongs to.
 */
export function PreviewLabSection({
  ctx,
  onPreviewRendered,
}: {
  ctx: AppleDrawerContext;
  onPreviewRendered: (preview: AppleRenderedPreview | null) => void;
}) {
  const { scope, pinRef, visible, actions } = ctx;
  const [targets, setTargets] = useState<IosSimulatorPreviewTarget[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [watch, setWatch] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const selected = useMemo(
    () => targets.find((target) => target.id === selectedId) ?? null,
    [selectedId, targets],
  );
  const laneId = scope.laneId;

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    setLoading(true);
    void window.ade.iosSimulator.listPreviewTargets({ laneId }, pinRef.current)
      .then((next) => {
        if (cancelled) return;
        setTargets(next);
        setSelectedId((current) => (current && next.some((target) => target.id === current) ? current : next[0]?.id ?? null));
      })
      .catch((cause: unknown) => { if (!cancelled) actions.reportError(cause); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // `actions` is a fresh object per render; only its stable `reportError` is used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId, pinRef, refreshNonce, visible]);

  const deliver = useCallback((dataUrl: string | null, targetLabel: string, error: string | null) => {
    if (dataUrl) {
      setRendered(true);
      onPreviewRendered({ dataUrl, targetLabel });
    } else {
      actions.reportError(new Error(error ?? "Preview render failed."));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onPreviewRendered]);

  const render = useCallback(async () => {
    if (!selected || rendering) return;
    setRendering(true);
    try {
      const result = await window.ade.iosSimulator.renderPreview({
        laneId,
        sourceFilePath: selected.sourceFilePath,
        previewDefinitionIndexInFile: selected.previewDefinitionIndexInFile,
        timeoutSec: 120,
      }, pinRef.current);
      deliver(result.dataUrl, selected.title, result.error);
    } catch (cause: unknown) {
      actions.reportError(cause);
    } finally {
      setRendering(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliver, laneId, pinRef, rendering, selected]);

  const renderCurrent = useCallback(async (target: IosSimulatorPreviewTarget) => {
    setRendering(true);
    try {
      const current = await window.ade.iosSimulator.renderCurrentPreview({
        laneId,
        sourceFile: target.sourceFile,
        sourceLine: target.sourceLine,
        timeoutSec: 120,
      }, pinRef.current);
      deliver(current.render?.dataUrl ?? null, current.target?.title ?? target.title, current.error ?? current.render?.error ?? null);
    } catch (cause: unknown) {
      actions.reportError(cause);
    } finally {
      setRendering(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliver, laneId, pinRef]);

  /* Watch file: the lane's workspace, filtered to the selected target's file. */
  const renderCurrentRef = useRef(renderCurrent);
  renderCurrentRef.current = renderCurrent;
  useEffect(() => {
    if (!watch || !visible || !selected) return undefined;
    let cancelled = false;
    let workspaceId: string | null = null;
    let timer: number | null = null;
    const target = selected;
    // The pin the watch was opened with; the stop goes to the same machine.
    const pin = pinRef.current;
    const unsubscribe = window.ade.files.onChange((event) => {
      if (cancelled) return;
      if (workspaceId && event.workspaceId !== workspaceId) return;
      if (!changeMatchesTarget(event.path, target)) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void renderCurrentRef.current(target); }, WATCH_DEBOUNCE_MS);
    });
    void window.ade.files.listWorkspaces({}, pin)
      .then((workspaces) => {
        if (cancelled) return;
        const workspace = workspaces.find((candidate) => candidate.laneId === laneId) ?? null;
        if (!workspace) return;
        workspaceId = workspace.id;
        return window.ade.files.watchChanges({ workspaceId: workspace.id }, pin);
      })
      .catch((cause: unknown) => { if (!cancelled) actions.reportError(cause); });
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
      if (workspaceId) void window.ade.files.stopWatching({ workspaceId }, pin).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId, pinRef, selected, visible, watch]);

  const busy = loading || rendering;

  return (
    <>
      <Row label="Target">
        <DrawerMenu
          ariaLabel="Preview target"
          value={selectedId}
          placeholder={loading ? "Loading…" : targets.length ? "Choose a preview" : "No previews found"}
          options={groupPreviewTargets(targets)}
          disabled={!visible || busy || targets.length === 0}
          onChange={setSelectedId}
        />
      </Row>
      <div className="flex min-h-7 items-center gap-1.5">
        <button type="button" className={DRAWER_PRIMARY_BUTTON} disabled={!visible || busy || !selected} onClick={() => { void render(); }}>
          {rendering ? "Rendering…" : "Render"}
        </button>
        <button
          type="button"
          className={DRAWER_GHOST_BUTTON}
          disabled={!rendered}
          onClick={() => { setRendered(false); onPreviewRendered(null); }}
        >
          Back to device
        </button>
      </div>
      <SwitchRow label="Watch file" checked={watch} disabled={!visible || !selected} onChange={setWatch} />

      <Subhead label="Workspace" />
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={DRAWER_BUTTON}
          disabled={!visible}
          onClick={() => {
            void window.ade.iosSimulator.ensurePreviewWorkspace({ laneId, openIfNeeded: true }, pinRef.current)
              .then((result) => { if (!result.ok && result.error) actions.reportError(new Error(result.error)); })
              .catch((cause: unknown) => actions.reportError(cause));
          }}
        >
          Open in Xcode
        </button>
        <button
          type="button"
          className={DRAWER_BUTTON}
          disabled={!visible}
          onClick={() => {
            void window.ade.iosSimulator.openPreviewWorkspace({ laneId }, pinRef.current)
              .catch((cause: unknown) => actions.reportError(cause));
          }}
        >
          Reveal workspace
        </button>
        <button
          type="button"
          className={DRAWER_GHOST_BUTTON}
          disabled={!visible || busy}
          onClick={() => setRefreshNonce((nonce) => nonce + 1)}
        >
          Refresh previews
        </button>
      </div>
    </>
  );
}
