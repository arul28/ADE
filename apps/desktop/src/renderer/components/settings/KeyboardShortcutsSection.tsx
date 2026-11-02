import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Plus } from "@phosphor-icons/react";
import type { KeybindingDefinition, KeybindingsSnapshot } from "../../../shared/types";
import { KEYBINDING_UNASSIGNED } from "../../../shared/keybindings";
import {
  bareKeyRefusal,
  captureBinding,
  chordId,
  findBindingConflicts,
  quickSlotChordConflict,
  reservedChord,
  resolveBindingChords,
  withOverride,
  type BindingConflict,
  type KeyboardPlatform,
  type ResolvedChord,
} from "../../../shared/keybindingEditor";
import { quickSlotLeaderLabel } from "../../../shared/quickSlots";
import { bindingChipLabel, getEffectiveBinding } from "../../lib/keybindings";
import { readKeybindingsSnapshot, writeKeybindingOverrides } from "../../lib/keybindingStore";
import { beginKeyCapture } from "../../lib/keyboardClaims";
import { isMacPlatform, isWindowsPlatform } from "../../lib/platform";
import { isWebClientMode } from "../../lib/webClientMode";
import { useAppStore } from "../../state/appStore";
import { useQuickSlotsStore } from "../../quickSlots/quickSlotsStore";
import { showToast } from "../app/toast/toastStore";
import { confirmDialog } from "../ui/dialog";
import { SettingsTextField } from "./primitives/SettingsControls";
import { ModernRow, ModernRows, ModernSection } from "./primitives/SettingsModern";
import "./KeyboardShortcutsSection.css";

/**
 * Settings › Keyboard › Shortcuts: rebind any action in `shared/keybindings.ts`.
 *
 * Shortcuts are this computer's (`lib/keybindingStore.ts`): every project and
 * every window on it reads the same set, and a save reaches them at once.
 * Every chord is checked before it is saved, by the rules in
 * `shared/keybindingEditor.ts`: other shortcuts a key press could also reach,
 * the Quick slots leader, and chords the OS, ADE's menu or the browser take
 * first.
 */

const SCOPE_ORDER: ReadonlyArray<{ scope: KeybindingDefinition["scope"]; label: string; hint: string }> = [
  { scope: "global", label: "Everywhere", hint: "On any page, even while you type." },
  { scope: "work", label: "Work", hint: "While the Work page is showing." },
  { scope: "chat", label: "Prompt box", hint: "The chat you last worked in, wherever it is." },
  { scope: "terminal", label: "Terminal", hint: "While the caret is in the terminal tool." },
  { scope: "lanes", label: "Lanes", hint: "While the Lanes page is showing and you are not typing." },
  { scope: "home", label: "Home", hint: "While Home is showing." },
  { scope: "files", label: "Files", hint: "While Files is showing." },
  { scope: "conflicts", label: "Conflicts", hint: "While resolving conflicts." },
  { scope: "history", label: "History", hint: "While History is showing." },
];

type Recording = { id: string; mode: "replace" | "add" };
type PendingConflict = { id: string; mode: Recording["mode"]; binding: string; conflicts: BindingConflict[] };

function currentPlatform(): KeyboardPlatform {
  if (isMacPlatform()) return "mac";
  return isWindowsPlatform() ? "windows" : "linux";
}

/** Each alternative of a binding as its own chip label. */
function bindingLabels(binding: string): string[] {
  return binding
    .split(",")
    .map((alternative) => bindingChipLabel(alternative.trim()))
    .filter((label): label is string => Boolean(label));
}

/** The modifiers held so far, drawn the way the chips draw them. */
function heldModifiersLabel(chord: Omit<ResolvedChord, "key">, platform: KeyboardPlatform): string {
  if (platform === "mac") {
    return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.meta ? "⌘" : ""}`;
  }
  return [chord.ctrl ? "Ctrl" : "", chord.alt ? "Alt" : "", chord.shift ? "Shift" : ""].filter(Boolean).join("+");
}

/** The binding minus any alternative whose chord is in `chords`. */
function withoutChords(binding: string, chords: ReadonlySet<string>, platform: KeyboardPlatform): string {
  const kept = binding
    .split(",")
    .map((alternative) => alternative.trim())
    .filter((alternative) => {
      const chord = resolveBindingChords(alternative, platform)[0];
      return chord && !chords.has(chordId(chord));
    });
  return kept.length ? kept.join(",") : KEYBINDING_UNASSIGNED;
}

function Chips({ binding }: { binding: string }) {
  const labels = bindingLabels(binding);
  return <>{labels.map((label) => <kbd key={label} className="kit-kbd">{label}</kbd>)}</>;
}

export function KeyboardShortcutsSection() {
  const platform = useMemo(currentPlatform, []);
  const web = isWebClientMode();
  const snapshot: KeybindingsSnapshot = useAppStore((state) => state.keybindings) ?? readKeybindingsSnapshot();
  const definitions = snapshot.definitions;
  const leader = useQuickSlotsStore((state) => state.leader);

  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [held, setHeld] = useState("");
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [pending, setPending] = useState<PendingConflict | null>(null);

  const effective = useCallback(
    (definition: KeybindingDefinition) => getEffectiveBinding(snapshot, definition.id, definition.defaultBinding),
    [snapshot],
  );

  const save = useCallback((overrides: KeybindingsSnapshot["overrides"]) => {
    try {
      writeKeybindingOverrides(overrides);
    } catch (error) {
      showToast({
        tone: "error",
        title: "Could not save the shortcut",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const definitionById = useMemo(() => new Map(definitions.map((definition) => [definition.id, definition])), [definitions]);

  const commit = useCallback((id: string, mode: Recording["mode"], binding: string, replaceIds: readonly string[] = []) => {
    const definition = definitionById.get(id);
    if (!definition) return;
    const current = effective(definition);
    const next = mode === "add" && current
      ? [...new Set([...current.split(",").map((part) => part.trim()), binding])].join(",")
      : binding;
    let overrides = withOverride(snapshot, id, next, definition.defaultBinding, platform);
    const taken = new Set(resolveBindingChords(binding, platform).map(chordId));
    for (const otherId of replaceIds) {
      const other = definitionById.get(otherId);
      if (!other) continue;
      const remaining = withoutChords(effective(other), taken, platform);
      overrides = withOverride({ overrides }, otherId, remaining, other.defaultBinding, platform);
    }
    save(overrides);
  }, [definitionById, effective, platform, save, snapshot]);

  // ── The recorder ─────────────────────────────────────────────────────────
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const validateRef = useRef<(id: string, mode: Recording["mode"], binding: string, chord: ResolvedChord) => void>(() => {});
  validateRef.current = (id, mode, binding, chord) => {
    const definition = definitionById.get(id);
    if (!definition) return;
    // A shipped default on a menu chord is deliberate (the Lanes filter's ⌘F
    // arrives through the menu's Find claim), so re-recording it is allowed.
    const shipped = resolveBindingChords(definition.defaultBinding, platform).some((entry) => chordId(entry) === chordId(chord));
    const slot = quickSlotChordConflict(chord, leader, platform);
    const refusal = bareKeyRefusal(chord, definition, platform)
      ?? (shipped ? null : reservedChord(chord, platform, { web })?.reason)
      ?? (slot
        ? `Quick slot ${slot} uses ${quickSlotLeaderLabel(leader, platform === "mac")} ${slot} first. Pick another chord or change the Quick slots leader.`
        : null);
    if (refusal) {
      setRowError({ id, message: refusal });
      return;
    }
    const conflicts = findBindingConflicts({ selfId: id, binding, definitions, effectiveBinding: effective, platform });
    setRecording(null);
    setRowError(null);
    if (conflicts.length) {
      setPending({ id, mode, binding, conflicts });
      return;
    }
    commit(id, mode, binding);
  };

  useEffect(() => {
    if (!recording) return undefined;
    const endCapture = beginKeyCapture();
    // The native menu would otherwise take ⌘W or ⌘N before this page sees
    // them, closing the window instead of saying the chord is taken.
    const menu = !web ? window.ade?.app?.setIgnoreMenuShortcuts : undefined;
    void menu?.(true)?.catch?.(() => {});

    const onKeyDown = (event: KeyboardEvent) => {
      // Every key belongs to the recorder: no page shortcut, no Settings close.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const active = recordingRef.current;
      if (!active) return;
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        setRecording(null);
        setRowError(null);
        setHeld("");
        return;
      }
      const result = captureBinding(event, platform);
      if (result.kind === "ignore") return;
      if (result.kind === "modifiers") {
        setHeld(heldModifiersLabel(result.label, platform));
        return;
      }
      setHeld("");
      if (result.kind === "refuse") {
        setRowError({ id: active.id, message: result.reason });
        return;
      }
      validateRef.current(active.id, active.mode, result.binding, result.chord);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      event.stopPropagation();
      // A key-up reports the modifiers as they were before the release; the
      // released modifier itself is no longer held.
      setHeld(heldModifiersLabel({
        ctrl: event.ctrlKey && event.key !== "Control",
        meta: event.metaKey && event.key !== "Meta",
        alt: event.altKey && event.key !== "Alt",
        shift: event.shiftKey && event.key !== "Shift",
      }, platform));
    };
    const onBlur = () => {
      setRecording(null);
      setHeld("");
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      endCapture();
      void menu?.(false)?.catch?.(() => {});
    };
    // One capture session per recording target; platform and web never change.
  }, [recording, platform, web]);

  const startRecording = (id: string, mode: Recording["mode"]) => {
    setPending(null);
    setRowError(null);
    setHeld("");
    setRecording({ id, mode });
  };

  // ── What each row says about its keys ────────────────────────────────────
  const rowNotes = useMemo(() => {
    const notes = new Map<string, string[]>();
    for (const definition of definitions) {
      const binding = effective(definition);
      const out: string[] = [];
      const shipped = new Set(resolveBindingChords(definition.defaultBinding, platform).map(chordId));
      for (const chord of resolveBindingChords(binding, platform)) {
        const reserved = shipped.has(chordId(chord)) ? null : reservedChord(chord, platform, { web });
        if (reserved) out.push(reserved.reason);
        const slot = quickSlotChordConflict(chord, leader, platform);
        if (slot) out.push(`Quick slot ${slot} uses these keys first, so this shortcut never runs.`);
      }
      const conflicts = findBindingConflicts({ selfId: definition.id, binding, definitions, effectiveBinding: effective, platform });
      if (conflicts.length) out.push(`Same keys as ${conflicts.map((conflict) => conflict.description).join(", ")}.`);
      if (out.length) notes.set(definition.id, out);
    }
    return notes;
  }, [definitions, effective, leader, platform, web]);

  const overrides = snapshot.overrides;
  const overridden = new Set(overrides.map((override) => override.id));
  const needle = query.trim().toLowerCase();
  const visible = definitions.filter((definition) => {
    if (!needle) return true;
    const keys = bindingLabels(effective(definition)).join(" ").toLowerCase();
    return definition.description.toLowerCase().includes(needle)
      || definition.id.toLowerCase().includes(needle)
      || keys.includes(needle);
  });

  const renderHint = (definition: KeybindingDefinition): React.ReactNode => {
    if (recording?.id === definition.id) {
      const error = rowError?.id === definition.id ? rowError.message : null;
      return (
        <span aria-live="polite" className={error ? "ade-kb-warn" : undefined}>
          {error ?? (recording.mode === "add" ? "Press another chord for this action. Esc cancels." : "Press the new keys. Esc cancels.")}
        </span>
      );
    }
    if (pending?.id === definition.id) {
      return (
        <span className="ade-kb-pending" role="group" aria-label="Shortcut already in use">
          <span className="ade-kb-warn">
            <Chips binding={pending.binding} /> is already {pending.conflicts.map((conflict) => conflict.description).join(", ")}.
          </span>
          <button
            type="button"
            className="kit-btn"
            data-size="xs"
            onClick={() => {
              commit(pending.id, pending.mode, pending.binding, pending.conflicts.map((conflict) => conflict.id));
              setPending(null);
            }}
          >
            Use it here instead
          </button>
          <button type="button" className="kit-btn kit-btn-ghost" data-size="xs" onClick={() => setPending(null)}>
            Cancel
          </button>
        </span>
      );
    }
    const notes = rowNotes.get(definition.id);
    return notes ? <span className="ade-kb-warn">{notes.join(" ")}</span> : undefined;
  };

  const renderControl = (definition: KeybindingDefinition): React.ReactNode => {
    const binding = effective(definition);
    const labels = bindingLabels(binding);
    if (recording?.id === definition.id) {
      const error = rowError?.id === definition.id;
      return (
        <>
          <span className="ade-kb-capture" data-error={error || undefined}>{held || "Press keys…"}</span>
          {recording.mode === "replace" && labels.length ? (
            <button
              type="button"
              className="kit-btn kit-btn-ghost"
              data-size="sm"
              onClick={() => {
                setRecording(null);
                save(withOverride({ overrides }, definition.id, KEYBINDING_UNASSIGNED, definition.defaultBinding, platform));
              }}
            >
              Unassign
            </button>
          ) : null}
          <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={() => setRecording(null)}>
            Cancel
          </button>
        </>
      );
    }
    const isOverridden = overridden.has(definition.id);
    return (
      <>
        <button
          type="button"
          className="ade-kb-keys"
          aria-label={`Change the shortcut for ${definition.description}, now ${labels.join(" or ") || "unassigned"}`}
          onClick={() => startRecording(definition.id, "replace")}
        >
          {labels.length ? <Chips binding={binding} /> : <span className="ade-kb-unassigned">Unassigned</span>}
        </button>
        <button
          type="button"
          className="kit-icon-btn ade-kb-icon"
          title="Add another key"
          aria-label={`Add another key for ${definition.description}`}
          data-hidden={labels.length ? undefined : "true"}
          disabled={!labels.length}
          onClick={() => startRecording(definition.id, "add")}
        >
          <Plus size={12} />
        </button>
        <button
          type="button"
          className="kit-icon-btn ade-kb-icon"
          disabled={!isOverridden}
          data-hidden={isOverridden ? undefined : "true"}
          title={`Reset to ${bindingLabels(definition.defaultBinding).join(" or ")}`}
          aria-label={`Reset ${definition.description} to its default`}
          onClick={() => save(withOverride({ overrides }, definition.id, null, definition.defaultBinding, platform))}
        >
          <ArrowCounterClockwise size={12} />
        </button>
      </>
    );
  };

  return (
    <>
      <ModernSection
        group="Shortcuts"
        anchor="keyboard-shortcuts"
        title="Shortcuts"
        hint={web
          ? "Saved in this browser. Click a shortcut and press the new keys."
          : "Saved on this computer, for every project. Click a shortcut and press the new keys."}
        actions={
          <button
            type="button"
            className="kit-btn kit-btn-ghost"
            data-size="sm"
            disabled={!overrides.length}
            onClick={async () => {
              const ok = await confirmDialog({
                title: "Reset every shortcut?",
                message: "Every action goes back to its default keys. Quick slots are not changed.",
                confirmLabel: "Reset shortcuts",
              });
              if (ok) save([]);
            }}
          >
            Reset all
          </button>
        }
      >
        <div className="ade-kb-toolbar">
          <SettingsTextField value={query} onChange={setQuery} placeholder="Search actions or keys" ariaLabel="Search shortcuts" />
          {rowNotes.size ? (
            <span className="kit-tag" data-tone="warn">
              {rowNotes.size === 1 ? "1 needs a look" : `${rowNotes.size} need a look`}
            </span>
          ) : null}
        </div>
        {!visible.length ? <p className="ade-kb-empty">No shortcut matches “{query.trim()}”.</p> : null}
      </ModernSection>

      {SCOPE_ORDER.map(({ scope, label, hint }) => {
        const rows = visible.filter((definition) => definition.scope === scope);
        if (!rows.length) return null;
        return (
          <ModernSection key={scope} group="Shortcuts" title={label} hint={hint}>
            <ModernRows>
              {rows.map((definition) => (
                <ModernRow
                  key={definition.id}
                  title={definition.description}
                  hint={renderHint(definition)}
                  control={<div className="ade-kb-controls">{renderControl(definition)}</div>}
                />
              ))}
            </ModernRows>
          </ModernSection>
        );
      })}
    </>
  );
}
