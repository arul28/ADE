import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PrMentionableUser, PrRepoReference } from "../../../../shared/types/prs";
import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import { logRendererDebugEvent } from "../../../lib/debugLog";
import { isImeComposing } from "../../../lib/imeComposition";
import { ViewportOverlayPortal } from "../../ui/ViewportOverlayHost";
import { PrWritingScopeContext } from "./prMarkdownContext";

const SEARCH_DEBOUNCE_MS = 180;
const MAX_SUGGESTIONS = 8;

type Trigger = { kind: "mention" | "ref"; query: string; start: number };

type Suggestion =
  | { kind: "user"; user: PrMentionableUser }
  | { kind: "ref"; ref: PrRepoReference };

/** The `@name` or `#12` the caret is on, if any. Looks back a bounded distance. */
function readTrigger(value: string, caret: number): Trigger | null {
  // Mid-word, an insert would leave the rest of the word stuck to it.
  if (/[\w.-]/.test(value[caret] ?? "")) return null;
  const before = value.slice(Math.max(0, caret - 100), caret);
  const match = /(?:^|[\s(])(?:@([A-Za-z0-9_][\w.-]*)?|#([\p{L}\p{N}_-]*))$/u.exec(before);
  if (!match) return null;
  const query = match[1] ?? match[2] ?? "";
  const start = caret - query.length - 1;
  return { kind: value[start] === "@" ? "mention" : "ref", query, start };
}

function filterRefs(refs: PrRepoReference[], query: string): PrRepoReference[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return refs.slice(0, MAX_SUGGESTIONS);
  const byNumber = /^\d+$/.test(needle);
  const matches = refs.filter((ref) => (byNumber ? String(ref.number).startsWith(needle) : ref.title.toLowerCase().includes(needle)));
  // Enter takes the first row, so the number as typed has to be it.
  const exact = byNumber ? matches.filter((ref) => String(ref.number) === needle) : [];
  return [...exact, ...matches.filter((ref) => !exact.includes(ref))].slice(0, MAX_SUGGESTIONS);
}

/** A result set still shown while the next search runs must match what is typed now. */
function matchesTrigger(suggestion: Suggestion, trigger: Trigger): boolean {
  const needle = trigger.query.toLowerCase();
  if (suggestion.kind === "user") {
    return trigger.kind === "mention"
      && (suggestion.user.login.toLowerCase().includes(needle) || Boolean(suggestion.user.name?.toLowerCase().includes(needle)));
  }
  return trigger.kind === "ref" && filterRefs([suggestion.ref], trigger.query).length > 0;
}

export type PrWritingTextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Overrides the surrounding scope; the markdown editor passes its own repo. */
  repoOwner?: string;
  repoName?: string;
};

/**
 * The textarea every PR writing surface uses: `@` suggests people who can be
 * mentioned and `#` suggests issues and pull requests, inserted in place.
 */
export const PrWritingTextarea = React.forwardRef<HTMLTextAreaElement, PrWritingTextareaProps>(function PrWritingTextarea(
  { repoOwner: repoOwnerProp, repoName: repoNameProp, onKeyDown, onSelect, onBlur, ...rest },
  forwardedRef,
) {
  const scope = React.useContext(PrWritingScopeContext);
  const repoOwner = repoOwnerProp ?? scope?.repoOwner ?? null;
  const repoName = repoNameProp ?? scope?.repoName ?? null;
  const pin = scope?.pin ?? null;
  const pinKey = pin?.key ?? null;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [foundSuggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [foundFor, setFoundFor] = useState<Trigger | null>(null);
  // The host's answer for exactly this text stands as it is; an older answer
  // stays up only for what still fits, so Enter cannot insert a stale row.
  const suggestions = useMemo(() => {
    if (!trigger) return [];
    return foundFor === trigger ? foundSuggestions : foundSuggestions.filter((suggestion) => matchesTrigger(suggestion, trigger));
  }, [foundFor, foundSuggestions, trigger]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!forwardedRef) return;
    if (typeof forwardedRef === "function") forwardedRef(textareaRef.current);
    else forwardedRef.current = textareaRef.current;
  }, [forwardedRef]);

  const syncTrigger = React.useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    const caret = node.selectionStart ?? node.value.length;
    const next = node.selectionEnd === caret ? readTrigger(node.value, caret) : null;
    setTrigger((current) => (
      current?.kind === next?.kind && current?.query === next?.query && current?.start === next?.start ? current : next
    ));
    if (next) {
      const rect = node.getBoundingClientRect();
      setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 4, width: Math.min(rect.width, 360) });
    }
  }, []);

  useLayoutEffect(() => {
    syncTrigger();
    // The caret can only have moved with the value; selection changes arrive
    // through onSelect.
  }, [rest.value, syncTrigger]);

  useEffect(() => {
    const generation = ++requestRef.current;
    if (!trigger) {
      setSuggestions([]);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      const read = trigger.kind === "mention"
        ? window.ade.prs.searchMentionables({ repoOwner, repoName, query: trigger.query }, pin)
            .then((result) => result.users.slice(0, MAX_SUGGESTIONS).map((user): Suggestion => ({ kind: "user", user })))
        : window.ade.prs.getRepoReferences({ repoOwner, repoName }, pin)
            .then((refs) => filterRefs(refs, trigger.query).map((ref): Suggestion => ({ kind: "ref", ref })));
      read
        .then((next) => {
          if (generation !== requestRef.current) return;
          setSuggestions(next);
          setFoundFor(trigger);
          setActiveIndex(0);
        })
        .catch((error: unknown) => {
          logRendererDebugEvent("prs.writing_suggestions_failed", { kind: trigger.kind, error: error instanceof Error ? error.message : String(error) });
          if (generation === requestRef.current) setSuggestions([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // `pin` is keyed by its identity string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKey, repoName, repoOwner, trigger]);

  const close = React.useCallback(() => {
    requestRef.current += 1;
    setTrigger(null);
    setSuggestions([]);
  }, []);

  const apply = React.useCallback((suggestion: Suggestion) => {
    const node = textareaRef.current;
    if (!node || !trigger) return;
    const token = suggestion.kind === "user" ? `@${suggestion.user.login}` : `#${suggestion.ref.number}`;
    const caret = node.selectionStart ?? node.value.length;
    const after = node.value.slice(caret);
    // A space already there is reused and stepped over.
    const next = `${node.value.slice(0, trigger.start)}${token}${/^[ \t]/.test(after) ? "" : " "}${after}`;
    const nextCaret = trigger.start + token.length + 1;
    // The field is controlled; setting the value through the DOM's own setter
    // and firing `input` runs the caller's onChange like a real keystroke.
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(node, next);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    requestAnimationFrame(() => {
      const current = textareaRef.current;
      if (!current) return;
      current.focus();
      current.setSelectionRange(nextCaret, nextCaret);
    });
  }, [close, trigger]);

  const open = trigger != null && suggestions.length > 0 && anchor != null;
  const highlighted = Math.min(activeIndex, Math.max(0, suggestions.length - 1));

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !isImeComposing(event)) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if ((event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        const picked = suggestions[highlighted];
        if (picked) apply(picked);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
    }
    onKeyDown?.(event);
  };

  const list = useMemo(() => {
    if (!open || !anchor) return null;
    return (
      <ViewportOverlayPortal layer="tooltip">
        <div
          role="listbox"
          aria-label={trigger?.kind === "mention" ? "Mention someone" : "Reference an issue or pull request"}
          data-testid="pr-writing-suggestions"
          className="pointer-events-auto absolute overflow-hidden rounded-lg border shadow-2xl"
          style={{ left: anchor.left, bottom: anchor.bottom, width: anchor.width, background: COLORS.cardBgSolid, borderColor: COLORS.border, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary }}
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.kind === "user" ? `u:${suggestion.user.login}` : `r:${suggestion.ref.kind}:${suggestion.ref.number}`}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => apply(suggestion)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
              style={{ background: index === highlighted ? COLORS.hoverBg : "transparent", border: "none", cursor: "pointer", color: "inherit" }}
            >
              {suggestion.kind === "user" ? (
                <>
                  {suggestion.user.avatarUrl ? <img src={suggestion.user.avatarUrl} alt="" width={16} height={16} className="rounded-full" /> : null}
                  <span style={{ fontFamily: MONO_FONT }}>@{suggestion.user.login}</span>
                  {suggestion.user.name ? <span className="truncate" style={{ color: COLORS.textMuted }}>{suggestion.user.name}</span> : null}
                </>
              ) : (
                <>
                  <span style={{ fontFamily: MONO_FONT, color: COLORS.textMuted }}>#{suggestion.ref.number}</span>
                  <span className="truncate">{suggestion.ref.title}</span>
                  <span className="ml-auto shrink-0" style={{ color: COLORS.textDim, fontSize: 11 }}>
                    {suggestion.ref.kind === "pr" ? "PR" : "Issue"}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      </ViewportOverlayPortal>
    );
  }, [anchor, apply, highlighted, open, suggestions, trigger?.kind]);

  return (
    <>
      <textarea
        {...rest}
        ref={textareaRef}
        onKeyDown={handleKeyDown}
        onSelect={(event) => {
          syncTrigger();
          onSelect?.(event);
        }}
        onBlur={(event) => {
          close();
          onBlur?.(event);
        }}
      />
      {list}
    </>
  );
});
