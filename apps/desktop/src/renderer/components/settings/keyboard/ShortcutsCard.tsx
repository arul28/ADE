import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Command, MagnifyingGlass, Plus } from "@phosphor-icons/react";
import type { KeybindingDefinition, KeybindingsSnapshot } from "../../../../shared/types";
import { KEYBINDING_UNASSIGNED } from "../../../../shared/keybindings";
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
} from "../../../../shared/keybindingEditor";
import { quickSlotLeaderLabel, type QuickSlotsPreferences } from "../../../../shared/quickSlots";
import { bindingChipLabel, getEffectiveBinding } from "../../../lib/keybindings";
import { writeKeybindingOverrides } from "../../../lib/keybindingStore";
import { beginKeyCapture } from "../../../lib/keyboardClaims";
import { showToast } from "../../app/toast/toastStore";
import { confirmDialog } from "../../ui/dialog";
import { IntegrationCard } from "../integrations/IntegrationChrome";
import { BindingCaps, KeyCaps } from "./keyboardParts";

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

type Scope = KeybindingDefinition["scope"];

const SCOPE_ORDER: ReadonlyArray<{ scope: Scope; label: string; hint: string }> = [
  { scope: "global", label: "Everywhere", hint: "In any project, even while you type." },
  { scope: "work", label: "Work", hint: "While the Work page is showing." },
  { scope: "chat", label: "Prompt box", hint: "The chat you last worked in, wherever it is." },
  { scope: "terminal", label: "Terminal", hint: "While the caret is in the terminal tool." },
  { scope: "lanes", label: "Lanes", hint: "While Lanes is showing and you are not typing." },
  { scope: "home", label: "Home", hint: "While Home is showing." },
  { scope: "files", label: "Files", hint: "While Files is showing." },
  { scope: "conflicts", label: "Conflicts", hint: "While resolving conflicts." },
  { scope: "history", label: "History", hint: "While History is showing." },
];

type Recording = { id: string; mode: "replace" | "add" };
type PendingConflict = { id: string; mode: Recording["mode"]; binding: string; conflicts: BindingConflict[] };

/** The modifiers held so far, one keycap each, in the OS's order. */
function heldModifierKeys(chord: Omit<ResolvedChord, "key">, platform: KeyboardPlatform): string[] {
  if (platform === "mac") {
    return [chord.ctrl && "⌃", chord.alt && "⌥", chord.shift && "⇧", chord.meta && "⌘"].filter((key): key is string => Boolean(key));
  }
  return [chord.ctrl && "Ctrl", chord.alt && "Alt", chord.shift && "Shift"].filter((key): key is string => Boolean(key));
}

/** Each alternative's printed label, for search and for screen readers. */
function bindingLabels(binding: string): string[] {
  return binding
    .split(",")
    .map((alternative) => bindingChipLabel(alternative.trim()))
    .filter((label): label is string => Boolean(label));
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

export function ShortcutsCard({
  snapshot,
  notes,
  platform,
  web,
  leader,
}: {
  snapshot: KeybindingsSnapshot;
  notes: ReadonlyMap<string, string[]>;
  platform: KeyboardPlatform;
  web: boolean;
  leader: QuickSlotsPreferences["leader"];
}) {
  const definitions = snapshot.definitions;
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<Scope | "all">("all");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [held, setHeld] = useState<string[]>([]);
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
        setHeld([]);
        return;
      }
      const result = captureBinding(event, platform);
      if (result.kind === "ignore") return;
      if (result.kind === "modifiers") {
        setHeld(heldModifierKeys(result.label, platform));
        return;
      }
      setHeld([]);
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
      setHeld(heldModifierKeys({
        ctrl: event.ctrlKey && event.key !== "Control",
        meta: event.metaKey && event.key !== "Meta",
        alt: event.altKey && event.key !== "Alt",
        shift: event.shiftKey && event.key !== "Shift",
      }, platform));
    };
    const onBlur = () => {
      setRecording(null);
      setHeld([]);
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
    setHeld([]);
    setRecording({ id, mode });
  };

  // ── What is showing ──────────────────────────────────────────────────────
  const overrides = snapshot.overrides;
  const overridden = new Set(overrides.map((override) => override.id));
  const needle = query.trim().toLowerCase();
  const matching = definitions.filter((definition) => {
    if (!needle) return true;
    const keys = bindingLabels(effective(definition)).join(" ").toLowerCase();
    return definition.description.toLowerCase().includes(needle)
      || definition.id.toLowerCase().includes(needle)
      || keys.includes(needle);
  });
  const scopes = SCOPE_ORDER
    .map((entry) => ({ ...entry, rows: matching.filter((definition) => definition.scope === entry.scope) }))
    .filter((entry) => entry.rows.length > 0);
  // A search that leaves the chosen scope empty shows every scope again, so a
  // filter whose button just disappeared never hides the results.
  const activeScope = scopes.some((entry) => entry.scope === scopeFilter) ? scopeFilter : "all";
  const shownScopes = activeScope === "all" ? scopes : scopes.filter((entry) => entry.scope === activeScope);

  const renderHint = (definition: KeybindingDefinition): React.ReactNode => {
    if (recording?.id === definition.id) {
      const error = rowError?.id === definition.id ? rowError.message : null;
      return (
        <span aria-live="polite" className={error ? "ade-kbp-warn" : undefined}>
          {error ?? (recording.mode === "add" ? "Press another chord for this action. Esc cancels." : "Press the new keys. Esc cancels.")}
        </span>
      );
    }
    if (pending?.id === definition.id) {
      return (
        <span className="ade-kbp-pending" role="group" aria-label="Shortcut already in use">
          <span className="ade-kbp-warn">
            <BindingCaps binding={pending.binding} /> is already {pending.conflicts.map((conflict) => conflict.description).join(", ")}.
          </span>
          <span className="ade-kbp-pending-actions">
            <button
              type="button"
              className="ade-modern-btn"
              data-size="sm"
              onClick={() => {
                commit(pending.id, pending.mode, pending.binding, pending.conflicts.map((conflict) => conflict.id));
                setPending(null);
              }}
            >
              Use it here instead
            </button>
            <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={() => setPending(null)}>
              Cancel
            </button>
          </span>
        </span>
      );
    }
    const rowNotes = notes.get(definition.id);
    return rowNotes ? <span className="ade-kbp-warn">{rowNotes.join(" ")}</span> : null;
  };

  const renderKeys = (definition: KeybindingDefinition): React.ReactNode => {
    const binding = effective(definition);
    const labels = bindingLabels(binding);
    if (recording?.id === definition.id) {
      const error = rowError?.id === definition.id;
      return (
        <>
          <span className="ade-kbp-capture" data-error={error || undefined}>
            {held.length ? <KeyCaps keys={held} /> : "Press keys…"}
          </span>
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
          className="kit-icon-btn ade-kbp-icon"
          data-reveal="hover"
          title="Add another key"
          aria-label={`Add another key for ${definition.description}`}
          hidden={!labels.length}
          onClick={() => startRecording(definition.id, "add")}
        >
          <Plus size={12} />
        </button>
        {isOverridden ? (
          <button
            type="button"
            className="kit-icon-btn ade-kbp-icon"
            title={`Reset to ${bindingLabels(definition.defaultBinding).join(" or ") || "unassigned"}`}
            aria-label={`Reset ${definition.description} to its default`}
            onClick={() => save(withOverride({ overrides }, definition.id, null, definition.defaultBinding, platform))}
          >
            <ArrowCounterClockwise size={12} />
          </button>
        ) : null}
        <button
          type="button"
          className="ade-kbp-keys"
          aria-label={`Change the shortcut for ${definition.description}, now ${labels.join(" or ") || "unassigned"}`}
          onClick={() => startRecording(definition.id, "replace")}
        >
          {labels.length ? <BindingCaps binding={binding} /> : <span className="ade-kbp-unassigned">Unassigned</span>}
        </button>
      </>
    );
  };

  return (
    <IntegrationCard
      anchor="keyboard-shortcuts"
      icon={<Command size={16} weight="duotone" />}
      title="Shortcuts"
      hint="Click a key to change it. Esc cancels."
      badge={notes.size ? (
        <span className="kit-tag" data-tone="warn">{notes.size === 1 ? "1 needs a look" : `${notes.size} need a look`}</span>
      ) : null}
      actions={(
        <button
          type="button"
          className="ade-modern-btn"
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
          <ArrowCounterClockwise size={12} />
          Reset all
        </button>
      )}
    >
      <div className="ade-kbp-toolbar">
        <div className="kit-seg ade-kbp-scopes" data-case="sentence" role="radiogroup" aria-label="Where the shortcut works">
          <button type="button" role="radio" aria-checked={activeScope === "all"} onClick={() => setScopeFilter("all")}>
            All <span className="kit-num">{matching.length}</span>
          </button>
          {scopes.map(({ scope, label, rows }) => (
            <button key={scope} type="button" role="radio" aria-checked={activeScope === scope} onClick={() => setScopeFilter(scope)}>
              {label} <span className="kit-num">{rows.length}</span>
            </button>
          ))}
        </div>
        <label className="ade-kbp-search">
          <MagnifyingGlass size={13} aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actions or keys"
            aria-label="Search shortcuts"
          />
        </label>
      </div>

      {!shownScopes.length ? <p className="ade-kbp-empty">No shortcut matches “{query.trim()}”.</p> : null}

      {shownScopes.map(({ scope, label, hint, rows }) => (
        <section key={scope} className="ade-kbp-group" aria-label={label}>
          <header className="ade-kbp-group-head">
            <span className="kit-eyebrow">{label}</span>
            <span>{hint}</span>
          </header>
          <div className="ade-kbp-grid">
            {rows.map((definition) => {
              const rowHint = renderHint(definition);
              const active = recording?.id === definition.id || pending?.id === definition.id;
              return (
                <div
                  key={definition.id}
                  className="ade-kbp-row"
                  data-active={active || undefined}
                  data-wide={active || rowHint ? "true" : undefined}
                >
                  <div className="ade-kbp-row-main">
                    <span className="ade-kbp-row-title">
                      {overridden.has(definition.id) ? <span className="kit-dot" data-state="accent" title="Changed by you" /> : null}
                      {definition.description}
                    </span>
                    {rowHint ? <span className="ade-kbp-row-hint">{rowHint}</span> : null}
                  </div>
                  <div className="ade-kbp-row-keys">{renderKeys(definition)}</div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </IntegrationCard>
  );
}
