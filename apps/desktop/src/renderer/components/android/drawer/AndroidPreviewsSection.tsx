import { useEffect, useState, useSyncExternalStore } from "react";
import type { AndroidComposePreview, AndroidComposePreviewRender } from "../../../../shared/types/androidEmulator";
import { showToast } from "../../app/toast/toastStore";
import { revealProofArtifactRow } from "../../shared/recordingFormat";
import { cn } from "../../ui/cn";
import { DRAWER_BUTTON, DRAWER_INPUT, DRAWER_PRIMARY_BUTTON, Subhead } from "../../ui/drawerPrimitives";
import { Spinner } from "../../ui/Spinner";
import type { AndroidDrawerContext } from "./androidDrawerState";

/*
 * P3: the Previews group. It lists a Gradle module's Jetpack Compose
 * `@Preview` functions and renders the chosen ones to PNG with Google's
 * Android CLI (`listComposePreviews`, `renderComposePreviews`). No emulator
 * is needed. A render takes about 20 s (minutes on the first run), so it has
 * its own running state. The group unmounts when it closes, so the module,
 * the list and the last render live here, per lane and machine.
 *
 * The images come back inline (`data:` URLs): the brain that rendered them
 * can be on another machine, where a file path means nothing here.
 */

type PreviewState = {
  module: string;
  busy: "list" | "render" | null;
  previews: AndroidComposePreview[] | null;
  /** The fqns not to render; a new list keeps the choice for the previews it still has. */
  unchecked: ReadonlySet<string>;
  render: AndroidComposePreviewRender | null;
  error: unknown;
};

const states = new Map<string, PreviewState>();
const listeners = new Set<() => void>();
const EMPTY: PreviewState = { module: "app", busy: null, previews: null, unchecked: new Set(), render: null, error: null };

function update(key: string, change: (state: PreviewState) => PreviewState) {
  states.set(key, change(states.get(key) ?? EMPTY));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function previewLabel(preview: { fqn: string; name: string | null }): string {
  const method = preview.fqn.split(".").pop() ?? preview.fqn;
  return preview.name ? `${method} · ${preview.name}` : method;
}

export function AndroidPreviewsSection({
  ctx,
  chatSessionId,
  onOpenProof,
}: {
  ctx: AndroidDrawerContext;
  /** The chat whose proof drawer gets the images; null files them for the lane only. */
  chatSessionId: string | null;
  onOpenProof?: ((artifactId: string) => void) | undefined;
}) {
  const { laneId, pinRef, actions } = ctx;
  const key = `${pinRef.current?.key ?? "local"}:${laneId}`;
  const state = useSyncExternalStore(subscribe, () => states.get(key) ?? EMPTY);
  const [moduleDraft, setModuleDraft] = useState(state.module);
  const reportError = actions.reportError;

  // A refusal (no Android CLI, a failed build) goes to the drawer's error strip once.
  useEffect(() => {
    if (!state.error) return;
    reportError(state.error);
    update(key, (current) => ({ ...current, error: null }));
  }, [key, reportError, state.error]);

  const module = moduleDraft.trim() || "app";
  const busy = state.busy !== null;

  const list = () => {
    const pin = pinRef.current;
    update(key, (current) => ({ ...current, module, busy: "list", error: null }));
    void window.ade.androidEmulator.listComposePreviews({ laneId, module }, pin)
      .then((result) => update(key, (current) => ({ ...current, busy: null, previews: result.previews })))
      .catch((cause: unknown) => update(key, (current) => ({ ...current, busy: null, error: cause })));
  };

  const chosen = (state.previews ?? []).filter((preview) => !state.unchecked.has(preview.fqn));
  const names = new Map((state.previews ?? []).map((preview) => [preview.fqn, preview.name]));
  const render = () => {
    const pin = pinRef.current;
    const fqns = chosen.map((preview) => preview.fqn);
    update(key, (current) => ({ ...current, busy: "render", error: null }));
    void window.ade.androidEmulator.renderComposePreviews({ laneId, module: state.module, fqns, inline: true, ...(chatSessionId ? { chatSessionId } : {}) }, pin)
      .then((result) => {
        update(key, (current) => ({ ...current, busy: null, render: result }));
        const drawn = result.images.filter((image) => image.path).length;
        showToast({
          id: `android-previews-${laneId}`,
          tone: drawn === result.images.length ? "success" : "warning",
          title: `${drawn} of ${result.images.length} previews rendered`,
          message: drawn ? "Filed as proof." : undefined,
        });
      })
      .catch((cause: unknown) => update(key, (current) => ({ ...current, busy: null, error: cause })));
  };

  const toggle = (fqn: string) => update(key, (current) => {
    const unchecked = new Set(current.unchecked);
    if (!unchecked.delete(fqn)) unchecked.add(fqn);
    return { ...current, unchecked };
  });

  const openProof = (artifactId: string) => {
    if (onOpenProof) onOpenProof(artifactId);
    else revealProofArtifactRow(artifactId);
  };

  return (
    <>
      <Subhead label="Compose previews" />
      <div className="flex min-h-7 items-center gap-1.5">
        <input
          className={cn(DRAWER_INPUT, "min-w-0 flex-1 font-mono")}
          placeholder="app"
          aria-label="Gradle module"
          title="The Gradle module's folder in the lane, such as app or feature/home"
          value={moduleDraft}
          disabled={busy}
          onChange={(event) => setModuleDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !busy) list(); }}
        />
        <button
          type="button"
          className={DRAWER_BUTTON}
          disabled={busy}
          title="Build the module with Gradle and list its @Preview functions (Android CLI)"
          data-testid="android-drawer-list-previews"
          onClick={list}
        >
          {state.busy === "list" ? <Spinner /> : null}
          {state.busy === "list" ? "Finding…" : "Find previews"}
        </button>
      </div>
      {state.previews && state.previews.length === 0 ? (
        <p className="text-[11px] text-muted-fg/70">{`${state.module} has no @Preview functions.`}</p>
      ) : null}
      {state.previews && state.previews.length > 0 ? (
        <>
          <ul className="flex min-w-0 flex-col gap-0.5" aria-label="Previews">
            {state.previews.map((preview) => (
              <li key={preview.fqn} className="min-w-0">
                <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[11.5px]" title={preview.fqn}>
                  <input
                    type="checkbox"
                    checked={!state.unchecked.has(preview.fqn)}
                    disabled={busy}
                    onChange={() => toggle(preview.fqn)}
                  />
                  <span className="min-w-0 truncate font-mono">{previewLabel(preview)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex min-h-7 items-center justify-end">
            <button
              type="button"
              className={DRAWER_PRIMARY_BUTTON}
              disabled={busy || chosen.length === 0}
              title="Render the checked previews to PNG with no emulator, and file them as proof"
              data-testid="android-drawer-render-previews"
              onClick={render}
            >
              {state.busy === "render" ? <Spinner /> : null}
              {state.busy === "render" ? "Rendering…" : `Render ${chosen.length}`}
            </button>
          </div>
        </>
      ) : null}
      {state.render && state.render.images.length > 0 ? (
        <ul className="grid min-w-0 grid-cols-2 gap-2" aria-label="Rendered previews" data-testid="android-drawer-preview-images">
          {state.render.images.map((image) => {
            // A render of named previews answers no names; the list has them.
            const label = previewLabel({ fqn: image.fqn, name: image.name ?? names.get(image.fqn) ?? null });
            const artifactId = image.proofArtifactId;
            return (
              <li key={image.fqn} className="flex min-w-0 flex-col gap-1">
                {image.dataUrl ? (
                  <button
                    type="button"
                    className="overflow-hidden rounded-md border border-[color:var(--kit-rule)] bg-[color:var(--kit-card-bg)] disabled:cursor-default"
                    disabled={!artifactId}
                    title={artifactId ? `Open ${label} in proof` : label}
                    onClick={() => { if (artifactId) openProof(artifactId); }}
                  >
                    <img src={image.dataUrl} alt={label} className="block h-auto w-full" draggable={false} />
                  </button>
                ) : (
                  <div className="flex min-h-16 items-center rounded-md border border-dashed border-[color:var(--kit-rule)] p-2 text-[11px] text-[var(--color-error)]">
                    {image.error ?? (image.path ? "Too large to show here; open it in proof." : "No image")}
                  </div>
                )}
                <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-fg/80" title={image.fqn}>{label}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {state.render && state.render.skipped > 0 ? (
        <p className="text-[11px] text-muted-fg/70">{`${state.render.skipped} more previews were not rendered (24 at a time).`}</p>
      ) : null}
    </>
  );
}
