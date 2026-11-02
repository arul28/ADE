import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Plus } from "@phosphor-icons/react";
import type { KeybindingDefinition, KeybindingsSnapshot } from "../../../shared/types";
import {
  KEYBINDING_DEFINITIONS,
  KEYBINDING_UNASSIGNED,
  WEB_KEYBINDING_DEFINITIONS,
} from "../../../shared/keybindings";
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
import { beginKeyCapture } from "../../lib/keyboardClaims";
import { isMacPlatform, isWindowsPlatform } from "../../lib/platform";
import { isWebClientMode } from "../../lib/webClientMode";
import { rootAppStoreApi, useAppStore, useAppStoreApi } from "../../state/appStore";
import { useQuickSlotsStore } from "../../quickSlots/quickSlotsStore";
import { showToast } from "../app/toast/toastStore";
import { confirmDialog } from "../ui/dialog";
import { SettingsTextField } from "./primitives/SettingsControls";
import { ModernSection } from "./primitives/SettingsModern";
import "./KeyboardShortcutsSection.css";

/**
 * Settings › Keyboard › Shortcuts: the editor for ADE's keybinding store.
 *
 * The store (`keybindingsService`, reached through `window.ade.keybindings`)
 * already keeps overrides and every surface already reads them through
 * `getEffectiveBinding`; this is the first UI that writes them. Every chord is
 * checked before it is saved: against ADE's other shortcuts in a scope that
 * can hear the same key, against the Quick slots leader, and against chords
 * the OS, ADE's own menu or the browser take first.
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
function heldModifiersLabel(chord: ResolvedChord, platform: KeyboardPlatform): string {
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

export function KeyboardShortcutsSection() {
  const platform = useMemo(currentPlatform, []);
  const web = isWebClientMode();
  const definitions = web ? WEB_KEYBINDING_DEFINITIONS : KEYBINDING_DEFINITIONS;
  const store = useAppStoreApi();
  const snapshot = useAppStore((state) => state.keybindings);
  const leader = useQuickSlotsStore((state) => state.leader);

  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [held, setHeld] = useState("");
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [pending, setPending] = useState<PendingConflict | null>(null);
  const [saving, setSaving] = useState(false);

  // A Settings page opened before the project answered (or with no project
  // at all) has no snapshot. Ask once; a store that cannot answer leaves the
  // page read-only with the defaults showing.
  useEffect(() => {
    if (snapshot) {
      setReadOnlyReason(null);
      return;
    }
    let cancelled = false;
    void window.ade.keybindings.get()
      .then((next) => {
        if (!cancelled) store.getState().applyKeybindingsSnapshot(next);
      })
      .catch(() => {
        if (!cancelled) setReadOnlyReason("Open a project to change shortcuts. These are the defaults.");
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot, store]);

  const effective = useCallback(
    (definition: KeybindingDefinition) => getEffectiveBinding(snapshot, definition.id, definition.defaultBinding),
    [snapshot],
  );

  const publish = useCallback((next: KeybindingsSnapshot) => {
    store.getState().applyKeybindingsSnapshot(next);
    // The shell above the project surface (palette, sidebar, Quick slots)
    // reads its own copy; keep it in step.
    if (rootAppStoreApi !== store) rootAppStoreApi.getState().applyKeybindingsSnapshot(next);
  }, [store]);

  const save = useCallback(async (overrides: KeybindingsSnapshot["overrides"]) => {
    const previous = snapshot;
    const base = snapshot?.definitions ?? definitions;
    publish({ definitions: base, overrides });
    setSaving(true);
    try {
      publish(await window.ade.keybindings.set(overrides));
    } catch (error) {
      if (previous) publish(previous);
      showToast({
        tone: "error",
        title: "Could not save the shortcut",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  }, [definitions, publish, snapshot]);

  const definitionById = useMemo(() => new Map(definitions.map((definition) => [definition.id, definition])), [definitions]);

  const commit = useCallback((id: string, mode: Recording["mode"], binding: string, replaceIds: readonly string[] = []) => {
    const definition = definitionById.get(id);
    if (!definition || !snapshot) return;
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
    void save(overrides);
  }, [definitionById, effective, platform, save, snapshot]);

  // ── The recorder ─────────────────────────────────────────────────────────
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const validateRef = useRef<(id: string, mode: Recording["mode"], binding: string, chord: ResolvedChord) => void>(() => {});
  validateRef.current = (id, mode, binding, chord) => {
    const definition = definitionById.get(id);
    if (!definition) return;
    const shipped = resolveBindingChords(definition.defaultBinding, platform).some((entry) => chordId(entry) === chordId(chord));
    const refusal = bareKeyRefusal(chord, definition, platform)
      ?? (shipped ? null : reservedChord(chord, platform, { web })?.reason)
      ?? (() => {
        const slot = quickSlotChordConflict(chord, leader, platform);
        return slot
          ? `Quick slot ${slot} uses ${quickSlotLeaderLabel(leader, platform === "mac")} ${slot} first. Pick another chord or change the Quick slots leader.`
          : null;
      })();
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
    // them, closing the window instead of telling you the chord is taken.
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
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) setHeld("");
      else setHeld(heldModifiersLabel({ key: "", ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey }, platform));
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
    if (readOnlyReason || !snapshot) return;
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
      // A shipped default on a menu chord is deliberate (the Lanes filter's
      // ⌘F arrives through the menu's Find claim), so only a chord the user
      // chose is checked against the reserved table.
      const shipped = new Set(resolveBindingChords(definition.defaultBinding, platform).map(chordId));
      for (const chord of resolveBindingChords(binding, platform)) {
        const reserved = shipped.has(chordId(chord)) ? null : reservedChord(chord, platform, { web });
        if (reserved) out.push(reserved.reason);
        const slot = quickSlotChordConflict(chord, leader, platform);
        if (slot) out.push(`Quick slot ${slot} uses these keys first, so this shortcut never runs.`);
      }
      const conflicts = findBindingConflicts({ selfId: definition.id, binding, definitions, effectiveBinding: effective, platform });
      if (conflicts.length) {
        out.push(`Same keys as ${conflicts.map((conflict) => conflict.description).join(", ")}.`);
      }
      if (out.length) notes.set(definition.id, out);
    }
    return notes;
  }, [definitions, effective, leader, platform, web]);

  const overrides = snapshot?.overrides ?? [];
  const overridden = new Set(overrides.map((override) => override.id));
  const needle = query.trim().toLowerCase();
  const visible = definitions.filter((definition) => {
    if (!needle) return true;
    const keys = bindingLabels(effective(definition)).join(" ").toLowerCase();
    return definition.description.toLowerCase().includes(needle)
      || definition.id.toLowerCase().includes(needle)
      || keys.includes(needle);
  });
  const problemCount = rowNotes.size;

  return (
    <ModernSection
      group="Shortcuts"
      anchor="keyboard-shortcuts"
      title="Shortcuts"
      hint={
        readOnlyReason
          ?? (web
            ? "Saved in this browser. Click a shortcut, then press the new keys. Esc cancels."
            : "Saved with the open project, so each project can keep its own. Click a shortcut, then press the new keys. Esc cancels.")
      }
      actions={
        <button
          type="button"
          className="ade-qs-settings-link"
          disabled={!overrides.length || saving || Boolean(readOnlyReason)}
          onClick={async () => {
            const ok = await confirmDialog({
              title: "Reset every shortcut?",
              message: "Every action goes back to its default keys. Quick slots are not changed.",
              confirmLabel: "Reset shortcuts",
            });
            if (ok) void save([]);
          }}
        >
          Reset all
        </button>
      }
    >
      <div className="ade-kb-toolbar">
        <SettingsTextField
          value={query}
          onChange={setQuery}
          placeholder="Search actions or keys"
          ariaLabel="Search shortcuts"
        />
        {problemCount ? (
          <span className="ade-kb-count" data-tone="warn">
            {problemCount === 1 ? "1 shortcut needs a look" : `${problemCount} shortcuts need a look`}
          </span>
        ) : null}
      </div>

      {SCOPE_ORDER.map(({ scope, label, hint }) => {
        const rows = visible.filter((definition) => definition.scope === scope);
        if (!rows.length) return null;
        return (
          <div key={scope} className="ade-kb-group">
            <div className="ade-kb-group-head">
              <span className="ade-kb-group-title">{label}</span>
              <span className="ade-kb-group-hint">{hint}</span>
            </div>
            <div className="ade-modern-rows">
              {rows.map((definition) => {
                const binding = effective(definition);
                const labels = bindingLabels(binding);
                const isRecording = recording?.id === definition.id;
                const isPending = pending?.id === definition.id;
                const notes = rowNotes.get(definition.id);
                const error = rowError?.id === definition.id ? rowError.message : null;
                const isOverridden = overridden.has(definition.id);
                const editable = !readOnlyReason && Boolean(snapshot);
                return (
                  <div key={definition.id} className="ade-ap-rowcard ade-kb-row" data-recording={isRecording || undefined}>
                    <div className="ade-kb-row-text">
                      <div className="ade-ap-rowtitle">{definition.description}</div>
                      {isRecording ? (
                        <div className="ade-ap-rowhint" aria-live="polite">
                          {error ?? (recording?.mode === "add" ? "Press another chord for this action. Esc cancels." : "Press the new keys. Esc cancels.")}
                        </div>
                      ) : isPending && pending ? (
                        <div className="ade-kb-pending" role="group" aria-label="Shortcut already in use">
                          <span>
                            {bindingLabels(pending.binding).join(" ")} is already {pending.conflicts.map((conflict) => conflict.description).join(", ")}.
                          </span>
                          <button
                            type="button"
                            className="ade-qs-settings-add"
                            onClick={() => {
                              commit(pending.id, pending.mode, pending.binding, pending.conflicts.map((conflict) => conflict.id));
                              setPending(null);
                            }}
                          >
                            Use it here instead
                          </button>
                          <button type="button" className="ade-qs-settings-link" onClick={() => setPending(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : notes ? (
                        <div className="ade-ap-rowhint ade-kb-note">{notes.join(" ")}</div>
                      ) : null}
                    </div>
                    <div className="ade-kb-row-controls">
                      {isRecording ? (
                        <>
                          <span className="ade-kb-capture" data-error={error ? "true" : undefined}>
                            {held || "Press keys…"}
                          </span>
                          {recording?.mode === "replace" && labels.length ? (
                            <button
                              type="button"
                              className="ade-qs-settings-link"
                              onClick={() => {
                                setRecording(null);
                                void save(withOverride({ overrides }, definition.id, KEYBINDING_UNASSIGNED, definition.defaultBinding, platform));
                              }}
                            >
                              Unassign
                            </button>
                          ) : null}
                          <button type="button" className="ade-qs-settings-link" onClick={() => setRecording(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="ade-kb-keys"
                            disabled={!editable}
                            data-unassigned={labels.length ? undefined : "true"}
                            aria-label={`Change the shortcut for ${definition.description}, now ${labels.join(" or ") || "unassigned"}`}
                            onClick={() => startRecording(definition.id, "replace")}
                          >
                            {labels.length
                              ? labels.map((chip) => <kbd key={chip} className="ade-kb-chip">{chip}</kbd>)
                              : <span className="ade-kb-unassigned">Unassigned</span>}
                          </button>
                          {labels.length ? (
                            <button
                              type="button"
                              className="ade-kb-icon"
                              disabled={!editable}
                              title="Add another key"
                              aria-label={`Add another key for ${definition.description}`}
                              onClick={() => startRecording(definition.id, "add")}
                            >
                              <Plus size={12} />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="ade-kb-icon"
                            disabled={!editable || !isOverridden}
                            data-hidden={isOverridden ? undefined : "true"}
                            title={`Reset to ${bindingLabels(definition.defaultBinding).join(" or ")}`}
                            aria-label={`Reset ${definition.description} to its default`}
                            onClick={() => void save(withOverride({ overrides }, definition.id, null, definition.defaultBinding, platform))}
                          >
                            <ArrowCounterClockwise size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {!visible.length ? <p className="ade-qs-settings-empty">No shortcut matches “{query.trim()}”.</p> : null}
    </ModernSection>
  );
}
