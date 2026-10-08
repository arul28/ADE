import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, CaretDown, Check, Drop, FloppyDisk, PencilSimple, Plus, SquaresFour, Trash } from "@phosphor-icons/react";
import { confirmDialog, promptDialog } from "../ui/dialog";
import { Z_LAYERS } from "../ui/zLayers";
import { useAppStore } from "../../state/appStore";
import { projectSidebarShortcutLabel } from "../app/projectSidebar/projectSidebarTabs";
import { HOME_LAYOUT_KEYBINDING, HOME_LAYOUT_PRESETS_MAX, useHomeLayoutStore } from "./homeLayout";
import { useHomeGridMetrics } from "./HomeWidgetGrid";
import "./homeWidgets.css";

const HomeWidgetPicker = lazy(() => import("./HomeWidgetPicker"));

/**
 * Edit mode's toolbar, shown in place of the hero actions: add a widget, set
 * the cards' look, reset, done. Loaded only when someone customizes the page.
 */

/** The theme's own card fill and blur, read from the tokens this page would otherwise use. */
function themeCardDefaults(): { opacity: number; blur: number } {
  const root = getComputedStyle(document.documentElement);
  const bg = root.getPropertyValue("--kit-card-bg");
  const blur = root.getPropertyValue("--kit-card-blur");
  const opacity = Number(/(\d+(?:\.\d+)?)%\s*,\s*transparent\s*\)\s*$/.exec(bg.trim())?.[1] ?? 58);
  const blurPx = Number(/blur\((\d+(?:\.\d+)?)px\)/.exec(blur)?.[1] ?? 0);
  return { opacity: Math.round(opacity), blur: Math.round(blurPx) };
}

function AppearancePopover({ onClose }: { onClose: () => void }) {
  const appearance = useHomeLayoutStore((s) => s.layout.appearance);
  const setAppearance = useHomeLayoutStore((s) => s.setAppearance);
  const defaults = useMemo(themeCardDefaults, []);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node) && !(event.target as Element).closest?.("[data-home-popover-toggle]")) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  const opacity = appearance.cardOpacity ?? defaults.opacity;
  const blur = appearance.cardBlur ?? defaults.blur;
  const customized = appearance.cardOpacity != null || appearance.cardBlur != null;
  return (
    <div ref={ref} className="ade-home-look" role="dialog" aria-label="Card look" style={{ zIndex: Z_LAYERS.popover }}>
      <label className="ade-home-look-row">
        <span>Card opacity</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={opacity}
          onChange={(event) => setAppearance({ cardOpacity: Number(event.target.value) })}
        />
        <output className="kit-num">{opacity}%</output>
      </label>
      <label className="ade-home-look-row">
        <span>Blur</span>
        <input
          type="range"
          min={0}
          max={40}
          step={1}
          value={blur}
          onChange={(event) => setAppearance({ cardBlur: Number(event.target.value) })}
        />
        <output className="kit-num">{blur}px</output>
      </label>
      <div className="ade-home-look-foot">
        <span>Only this page. Your theme and wallpaper stay as they are.</span>
        <button
          type="button"
          className="kit-btn kit-btn-ghost"
          disabled={!customized}
          onClick={() => setAppearance({ cardOpacity: null, cardBlur: null })}
        >
          Use theme look
        </button>
      </div>
    </div>
  );
}

/** Closes a popover on an outside pointer or Escape (toggle buttons carry `data-home-popover-toggle`). */
function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element;
      if (ref.current && !ref.current.contains(target) && !target.closest?.("[data-home-popover-toggle]")) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, ref]);
}

function LayoutsPopover({ onClose }: { onClose: () => void }) {
  const presets = useHomeLayoutStore((s) => s.presets);
  const activeId = useHomeLayoutStore((s) => s.activeId);
  const switchPreset = useHomeLayoutStore((s) => s.switchPreset);
  const savePresetAs = useHomeLayoutStore((s) => s.savePresetAs);
  const renamePreset = useHomeLayoutStore((s) => s.renamePreset);
  const deletePreset = useHomeLayoutStore((s) => s.deletePreset);
  const keybindings = useAppStore((s) => s.keybindings);
  const shortcut = projectSidebarShortcutLabel(keybindings, HOME_LAYOUT_KEYBINDING);
  const ref = useRef<HTMLDivElement | null>(null);
  // A prompt is a dialog over the page; the popover stays put under it.
  const [prompting, setPrompting] = useState(false);
  useDismiss(ref, prompting ? () => {} : onClose);
  const full = presets.length >= HOME_LAYOUT_PRESETS_MAX;
  const nameTaken = (value: string, exceptId?: string) =>
    presets.some((preset) => preset.id !== exceptId && preset.name.toLowerCase() === value.trim().toLowerCase())
      ? "A layout already has that name."
      : null;

  const saveAs = async () => {
    setPrompting(true);
    const name = await promptDialog({
      title: "Save layout as",
      message: "Saves the widgets, sizes, order and card look you see now.",
      placeholder: "Focus, Reviews, Monday…",
      confirmLabel: "Save",
      validate: (value) => nameTaken(value),
    });
    setPrompting(false);
    if (name) savePresetAs(name);
  };
  const rename = async (id: string, current: string) => {
    setPrompting(true);
    const name = await promptDialog({ title: "Rename layout", defaultValue: current, confirmLabel: "Rename", validate: (value) => nameTaken(value, id) });
    setPrompting(false);
    if (name) renamePreset(id, name);
  };
  const remove = async (id: string, name: string) => {
    setPrompting(true);
    const confirmed = await confirmDialog({ title: `Delete "${name}"?`, message: "Only this saved layout is deleted. The others stay as they are.", confirmLabel: "Delete", destructive: true });
    setPrompting(false);
    if (confirmed) deletePreset(id);
  };

  return (
    <div ref={ref} className="ade-home-look ade-home-layouts" role="dialog" aria-label="Saved layouts" style={{ zIndex: Z_LAYERS.popover }}>
      <div className="ade-home-layouts-list" role="radiogroup" aria-label="Layout">
        {presets.map((preset) => (
          <div key={preset.id} className="ade-home-layouts-row" data-active={preset.id === activeId || undefined}>
            <button
              type="button"
              role="radio"
              aria-checked={preset.id === activeId}
              className="ade-home-layouts-pick"
              onClick={() => switchPreset(preset.id)}
            >
              <span className="ade-home-layouts-check" aria-hidden>{preset.id === activeId ? <Check size={12} weight="bold" /> : null}</span>
              <span className="ade-home-layouts-name">{preset.name}</span>
              <span className="ade-home-layouts-count kit-num">{preset.layout.items.length}</span>
            </button>
            <button type="button" className="kit-icon-btn" aria-label={`Rename ${preset.name}`} title="Rename" onClick={() => void rename(preset.id, preset.name)}>
              <PencilSimple size={12} />
            </button>
            <button
              type="button"
              className="kit-icon-btn"
              aria-label={`Delete ${preset.name}`}
              title={presets.length <= 1 ? "Your only layout" : "Delete"}
              disabled={presets.length <= 1}
              onClick={() => void remove(preset.id, preset.name)}
            >
              <Trash size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="ade-home-look-foot">
        <span>
          {full
            ? `${HOME_LAYOUT_PRESETS_MAX} layouts is the most ADE keeps. Delete one to save another.`
            : shortcut && presets.length > 1 ? `${shortcut} switches layouts.` : "Every change saves to the layout that is showing."}
        </span>
        <button
          type="button"
          className="kit-btn"
          disabled={full}
          onClick={() => void saveAs()}
        >
          <FloppyDisk size={12} aria-hidden /> Save as…
        </button>
      </div>
    </div>
  );
}

export default function HomeEditTools({ onDone }: { onDone: () => void }) {
  const reset = useHomeLayoutStore((s) => s.reset);
  const activeName = useHomeLayoutStore((s) => s.presets.find((preset) => preset.id === s.activeId)?.name ?? "Default");
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  const [layoutsOpen, setLayoutsOpen] = useState(false);
  // An empty cell on the page opens the gallery straight away, including the
  // click that turned edit mode on (the request is made before this mounts).
  const pickerRequest = useHomeGridMetrics((s) => s.pickerRequest);
  const seenRequest = useRef(0);
  useEffect(() => {
    if (pickerRequest > seenRequest.current) {
      seenRequest.current = pickerRequest;
      setGalleryOpen(true);
    }
  }, [pickerRequest]);
  return (
    <div className="ade-home-edit-bar">
      <div className="ade-home-look-anchor">
        <button
          type="button"
          className="ade-home-action"
          aria-expanded={layoutsOpen}
          aria-label={`Layout: ${activeName}`}
          title="Saved layouts"
          data-home-popover-toggle
          onClick={() => {
            setLookOpen(false);
            setLayoutsOpen((value) => !value);
          }}
        >
          <SquaresFour size={14} aria-hidden />
          <span className="ade-home-action-label ade-home-layouts-current">{activeName}</span>
          <CaretDown size={11} aria-hidden />
        </button>
        {layoutsOpen ? <LayoutsPopover onClose={() => setLayoutsOpen(false)} /> : null}
      </div>
      <button type="button" className="ade-home-action" onClick={() => setGalleryOpen(true)}>
        <Plus size={14} aria-hidden />
        <span className="ade-home-action-label">Add widget</span>
      </button>
      <div className="ade-home-look-anchor">
        <button
          type="button"
          className="ade-home-action"
          aria-expanded={lookOpen}
          data-home-popover-toggle
          onClick={() => {
            setLayoutsOpen(false);
            setLookOpen((value) => !value);
          }}
        >
          <Drop size={14} aria-hidden />
          <span className="ade-home-action-label">Card look</span>
        </button>
        {lookOpen ? <AppearancePopover onClose={() => setLookOpen(false)} /> : null}
      </div>
      <button
        type="button"
        className="ade-home-action"
        onClick={() => {
          void confirmDialog({
            title: `Reset "${activeName}"?`,
            message: "This layout's widgets, sizes, order and card look go back to the shipped home page. Other saved layouts stay.",
            confirmLabel: "Reset",
          }).then((confirmed) => {
            if (confirmed) reset();
          });
        }}
      >
        <ArrowCounterClockwise size={14} aria-hidden />
        <span className="ade-home-action-label">Reset</span>
      </button>
      <button type="button" className="ade-home-action" data-primary="true" onClick={onDone}>
        <Check size={14} weight="bold" aria-hidden />
        <span className="ade-home-action-label">Done</span>
      </button>
      {galleryOpen ? (
        <Suspense fallback={null}>
          <HomeWidgetPicker open={galleryOpen} onOpenChange={setGalleryOpen} />
        </Suspense>
      ) : null}
    </div>
  );
}
