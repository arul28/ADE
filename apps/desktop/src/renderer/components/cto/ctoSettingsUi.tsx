import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { usageLeftLevel } from "../usage/usageDesign";
import { SavedFlash, useSavedFlash } from "../settings/primitives";
import { isCtoNotesChangedError } from "../../../shared/types/cto";

/**
 * Small pieces the CTO surfaces share (the side panel and the settings
 * panes). Everything is drawn with the surface kit (`kit-*`) and the modern
 * settings classes (`ade-modern-*`, `ade-ap-*`); nothing here invents its own
 * panel style.
 */

/** `ModernSection` group for every CTO settings section. */
export const CTO_SETTINGS_GROUP = "CTO";

/**
 * An empty or loading list, said in a glyph and two or three words
 * ("Nothing scheduled"). One line; `hint` is the tooltip, for the rare case
 * where the next step is not obvious.
 */
export function CtoEmptyLine({
  icon,
  children,
  hint,
  tone,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  hint?: string;
  tone?: "crit";
}) {
  return (
    <p className="ade-cto-empty" title={hint} data-tone={tone} role={tone ? "status" : undefined}>
      {icon ? <span className="ade-cto-empty-icon" aria-hidden>{icon}</span> : null}
      <span className="ade-cto-empty-text">{children}</span>
    </p>
  );
}

const encoder = new TextEncoder();

/** UTF-8 size, the unit the notes caps are written in. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * "1,240 of 4,096 bytes" over a thin meter. Neutral while there is room; it
 * turns amber at 20% left and red at 5%, the same rule every ADE meter uses.
 */
export function ByteMeter({ used, limit }: { used: number; limit: number }) {
  const percentLeft = limit > 0 ? Math.max(0, ((limit - used) / limit) * 100) : 0;
  const over = used > limit;
  const level = over ? "crit" : usageLeftLevel(percentLeft);
  return (
    <div className="flex items-center gap-3">
      <div className="kit-meter flex-1" data-level={level} style={{ maxWidth: 220 }}>
        <span style={{ width: `${Math.min(100, (used / Math.max(1, limit)) * 100)}%` }} />
      </div>
      <span
        className="kit-num text-[11px]"
        style={{ color: over ? "var(--kit-crit)" : "var(--kit-text-3)" }}
      >
        {used.toLocaleString()} of {limit.toLocaleString()} bytes
      </span>
    </div>
  );
}

/** Copy to the clipboard, and say so for a moment. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [value]);
  return (
    <button type="button" className="kit-btn" data-size="sm" onClick={onCopy} aria-label={label}>
      {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
      {copied ? "Copied" : label}
    </button>
  );
}

/**
 * A text the CTO's host stores, edited in place and saved on its own.
 *
 * Saves 900 ms after typing stops and on blur, then flashes "Saved". While
 * the field is clean it follows the host. When the host text changes under
 * unsaved edits (the CTO wrote a note, the phone edited it) nothing is saved
 * over it: one quiet line says "Changed elsewhere" with a Reload that takes
 * the host's text. A text over `limit` bytes is not sent: the meter turns red
 * and says by how much.
 *
 * Each save carries the host's hash of the text the draft started from
 * (`hash`), so a change that lands between the last read and the save is
 * refused by the host and shown as the same "Changed elsewhere" line.
 */
export function AutosaveTextArea({
  value,
  hash,
  onSave,
  limit,
  rows = 8,
  placeholder,
  ariaLabel,
  mono = true,
}: {
  value: string;
  /** The host's hash of `value`, sent back on save so a stale write is refused. */
  hash?: string;
  onSave: (text: string, baseHash?: string) => Promise<void>;
  /** Byte cap; shows a meter when set. */
  limit?: number;
  rows?: number;
  placeholder?: string;
  ariaLabel: string;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  /** The host text the draft was last in step with (read or saved). */
  const savedRef = useRef(value);
  /** The host's hash of `savedRef`'s text. */
  const savedHashRef = useRef(hash);
  const hostHashRef = useRef(hash);
  /** The newest host text, whatever the draft holds. */
  const hostRef = useRef(value);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const timerRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  conflictRef.current = conflict;
  const { state, flash, fail } = useSavedFlash();

  const adoptHost = useCallback(() => {
    savedRef.current = hostRef.current;
    savedHashRef.current = hostHashRef.current;
    setDraft(hostRef.current);
    setConflict(false);
  }, []);

  useEffect(() => {
    hostRef.current = value;
    hostHashRef.current = hash;
    if (value === savedRef.current) {
      savedHashRef.current = hash;
      return;
    }
    // Our own save's answer is settled when the save returns.
    if (savingRef.current) return;
    if (draftRef.current === savedRef.current) {
      adoptHost();
    } else if (value === draftRef.current) {
      // The host caught up with the draft (the same edit, saved elsewhere).
      savedRef.current = value;
      savedHashRef.current = hash;
      setConflict(false);
    } else {
      setConflict(true);
    }
  }, [adoptHost, hash, value]);

  const bytes = utf8Bytes(draft);
  const over = limit != null && bytes > limit;

  const save = useCallback(async () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const text = draftRef.current;
    if (text === savedRef.current || savingRef.current || conflictRef.current) return;
    if (limit != null && utf8Bytes(text) > limit) return;
    savingRef.current = true;
    try {
      await onSave(text, savedHashRef.current);
      savedRef.current = text;
      // The host answers what it kept (secrets scrubbed, lines trimmed): a
      // clean field shows that, not what was typed.
      if (draftRef.current === text && hostRef.current !== text) adoptHost();
      flash();
    } catch (err) {
      if (isCtoNotesChangedError(err)) setConflict(true);
      else fail(err instanceof Error && err.message ? err.message : "Couldn't save.");
    } finally {
      savingRef.current = false;
    }
    // A keystroke that landed while the save was in flight is saved next.
    if (draftRef.current !== savedRef.current) {
      timerRef.current = window.setTimeout(() => void save(), 900);
    }
  }, [adoptHost, fail, flash, limit, onSave]);

  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
  }, []);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <textarea
        className="kit-input"
        aria-label={ariaLabel}
        aria-invalid={over ? true : undefined}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          if (timerRef.current != null) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => void save(), 900);
        }}
        onBlur={() => void save()}
        style={{
          width: "100%",
          minHeight: rows * 20,
          padding: "10px 12px",
          resize: "vertical",
          lineHeight: 1.65,
          fontFamily: mono ? "var(--font-mono)" : undefined,
          fontSize: mono ? 12 : 12.5,
        }}
      />
      <div className="flex min-h-[18px] flex-wrap items-center justify-between gap-3">
        {limit != null ? <ByteMeter used={bytes} limit={limit} /> : <span />}
        {conflict ? (
          <span
            role="status"
            className="inline-flex items-center gap-2 text-[12px] text-[color-mix(in_srgb,var(--kit-warn)_85%,var(--color-fg))]"
            title="Reload takes the saved text; your unsaved edits here are dropped"
          >
            Changed elsewhere
            <button type="button" className="kit-btn" data-size="xs" onClick={adoptHost}>
              Reload
            </button>
          </span>
        ) : over ? (
          <span className="text-[12px] text-[var(--kit-crit)]" title="Shorten it to save">
            {(bytes - limit!).toLocaleString()} bytes over
          </span>
        ) : (
          <SavedFlash state={state} />
        )}
      </div>
    </div>
  );
}
