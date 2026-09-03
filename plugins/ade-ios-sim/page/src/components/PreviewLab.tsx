/**
 * Preview Lab: the #Preview picker, its match line, and the four-button row.
 *
 * The compiled pane's `mode === "preview"` block, moved. The rendered PNG is
 * drawn here rather than by the host engine — a preview render is a data URL the
 * child hands back, not a live capture — which is exactly why the stage is
 * released while this surface is showing.
 *
 * "Setup docs" goes through `host/ui.ts:openLink` instead of
 * `window.ade.app.openExternal`; the host decides whether that is ADE's own
 * browser or the reader's.
 */

import React from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  DeviceMobile,
  FileCode,
  ImageSquare,
  SpinnerGap,
} from "@phosphor-icons/react";
import { cn } from "@ade-dev/ui";

import type {
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewMatch,
  IosSimulatorPreviewTarget,
  IosSimulatorRenderPreviewResult,
} from "../types";
import {
  previewMatchLabel,
  previewMatchTone,
  previewStatusLabel,
  previewTargetLabel,
} from "./simFormat";

export const XCODE_MCP_DOCS_URL =
  "https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode";

export function PreviewLab({
  capability,
  targets,
  match,
  selectedTargetId,
  preview,
  busy,
  canOpenInEditor,
  onSelect,
  onRender,
  onViewInSimulator,
  onRefresh,
  onOpenWorkspace,
  onOpenDocs,
}: {
  capability: IosSimulatorPreviewCapability | null;
  targets: IosSimulatorPreviewTarget[];
  match: IosSimulatorPreviewMatch | null;
  selectedTargetId: string | null;
  preview: IosSimulatorRenderPreviewResult | null;
  busy: boolean;
  canOpenInEditor: boolean;
  onSelect: (id: string | null) => void;
  onRender: () => void;
  onViewInSimulator: () => void;
  onRefresh: () => void;
  onOpenWorkspace: () => void;
  onOpenDocs: (url: string) => void;
}): React.ReactElement {
  const selected = targets.find((target) => target.id === selectedTargetId) ?? targets[0] ?? null;
  const ready = Boolean(capability?.supported && selected);
  return (
    <div className="space-y-1.5" data-sim-pane="preview-lab">
      <div className="flex items-center gap-2">
        {targets.length ? (
          <select
            className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-black/20 px-2 py-1.5 font-sans text-[11px] text-fg/75 outline-none"
            aria-label="Preview target"
            value={selected?.id ?? ""}
            onChange={(event) => onSelect(event.currentTarget.value || null)}
          >
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {previewTargetLabel(target)}
              </option>
            ))}
          </select>
        ) : (
          <div className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-black/20 px-2 py-1.5 font-sans text-[11px] text-muted-fg/60">
            {previewStatusLabel(capability, targets)}
          </div>
        )}
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-violet-300/20 bg-violet-400/10 px-2 font-sans text-[11px] font-medium text-violet-50/85 transition-colors hover:bg-violet-400/15 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!ready || busy}
          onClick={onRender}
          title="Render selected Xcode preview"
        >
          {busy ? <SpinnerGap size={13} className="animate-spin" /> : <ImageSquare size={13} />}
          Render
        </button>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-300/20 bg-emerald-400/10 px-2 font-sans text-[11px] font-medium text-emerald-50/85 transition-colors hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!selected || busy}
          onClick={onViewInSimulator}
          title="Launch the app in the live simulator with this preview target as debug context"
        >
          <DeviceMobile size={13} />
          View in simulator
        </button>
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5 px-1 font-sans text-[10px] text-muted-fg/55">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className={cn(
              "inline-flex h-5 shrink-0 items-center rounded border px-1.5 font-medium",
              previewMatchTone(match),
            )}
          >
            {previewMatchLabel(match)}
          </span>
          <span className="min-w-0 truncate" title={match?.reason ?? undefined}>
            {match?.reason ?? "No #Preview resolved yet."}
          </span>
        </div>
        <div
          className="min-w-0 shrink-0 truncate text-muted-fg/45"
          title={selected?.sourceFile ?? undefined}
        >
          {selected?.sourceFile ?? match?.suggestedSourceFile ?? "No #Preview selected"}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 font-sans text-[10px] font-medium text-muted-fg/60 transition-colors hover:text-fg/85"
          onClick={onRefresh}
          disabled={busy}
        >
          <ArrowClockwise size={11} className={busy ? "animate-spin" : undefined} />
          Refresh
        </button>
        {/*
          Drawn only when the host has an editor verb to answer with. A button
          that silently did nothing would be worse than no button, and the
          contract is optional on purpose — see `bridge.ts`.
        */}
        {canOpenInEditor ? (
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 font-sans text-[10px] font-medium text-muted-fg/60 transition-colors hover:text-fg/85"
            onClick={onOpenWorkspace}
          >
            <FileCode size={11} />
            Open Xcode
          </button>
        ) : null}
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 font-sans text-[10px] font-medium text-muted-fg/60 transition-colors hover:text-fg/85"
          onClick={() => onOpenDocs(capability?.docsUrl ?? XCODE_MCP_DOCS_URL)}
        >
          <ArrowSquareOut size={11} />
          Setup docs
        </button>
      </div>

      {preview?.dataUrl ? (
        <img
          className="max-h-[420px] w-full rounded-md border border-white/[0.08] object-contain"
          src={preview.dataUrl}
          alt="Rendered Xcode preview"
          data-sim-pane="preview-image"
        />
      ) : preview?.error ? (
        <div className="rounded-md border border-rose-300/20 bg-rose-400/[0.08] px-2 py-1.5 font-sans text-[10px] text-rose-50/85">
          {preview.error}
        </div>
      ) : null}
    </div>
  );
}
