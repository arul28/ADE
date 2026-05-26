/**
 * AnnotationPopover — floating popover used by the orchestration plan
 * panel to capture an ephemeral comment + selection excerpt and inject it
 * into the lead chat composer as an attachment (see `goal.md` §10.7).
 *
 * Lifecycle:
 *   1. Caller opens with an anchor describing what was selected
 *      (`text` | `image` | `iframe` | `mermaid` | `spec` | `section`).
 *   2. The popover gathers a free-form comment.
 *   3. On submit it composes an `OrchestrationContextItem`, dispatches
 *      `ade:agent-chat:add-plan-annotation` on `window`, and calls
 *      `onClose`. Nothing is persisted to the manifest in v1.
 *
 * The popover is rendered into a portal at `mountTarget` (defaults to
 * `document.body`) so it can escape clipping ancestors in the plan panel.
 * Position is computed from the supplied `anchorRect` or the centre of
 * the current viewport when no rect is given.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ORCHESTRATION_ANNOTATION_EVENT,
  type OrchestrationAnnotationAnchorKind,
  type OrchestrationAnnotationEventDetail,
  type OrchestrationContextItem,
} from "../../../shared/types/orchestration";
import { cn } from "../ui/cn";

export type AnnotationPopoverAnchor = {
  kind: OrchestrationAnnotationAnchorKind;
  /** Stable id for the anchored entity. Asset id for specs/images, section id for sections, ad-hoc for text. */
  id?: string;
  /** Short snippet of the anchored content so the lead sees what was annotated. */
  preview: string;
  /** Optional URL/path to the underlying asset. */
  href?: string;
  /** Plan section id (slug-hash) when the selection lives inside plan.md. */
  sectionId?: string;
  /** Selection excerpt — the literal text the user highlighted (empty for image/iframe anchors). */
  selectionExcerpt?: string;
};

export type AnnotationPopoverPosition = {
  /** Viewport-relative anchor rectangle the popover should attach to. */
  anchorRect?: DOMRect | null;
  /** Optional explicit (x, y) override; takes precedence over `anchorRect`. */
  origin?: { x: number; y: number };
};

export type AnnotationPopoverProps = {
  runId: string;
  sessionId: string | null;
  anchor: AnnotationPopoverAnchor;
  onClose: () => void;
  /** Optional callback invoked AFTER the CustomEvent dispatch and BEFORE onClose. */
  onSubmit?: (item: OrchestrationContextItem) => void;
  position?: AnnotationPopoverPosition;
  /** Optional DOM node to mount into (defaults to document.body). Useful for tests. */
  mountTarget?: Element | null;
};

const POPOVER_WIDTH = 320;
const POPOVER_PADDING = 12;
const POPOVER_MIN_INPUT_HEIGHT = 64;

function clampHorizontal(value: number): number {
  if (typeof window === "undefined") return value;
  const max = window.innerWidth - POPOVER_WIDTH - POPOVER_PADDING;
  return Math.max(POPOVER_PADDING, Math.min(value, max));
}

function clampVertical(value: number): number {
  if (typeof window === "undefined") return value;
  // Roughly cap so the popover doesn't drop off the bottom; the actual
  // height varies, but ~220 px is a safe envelope.
  const max = window.innerHeight - 220;
  return Math.max(POPOVER_PADDING, Math.min(value, max));
}

/**
 * Dispatches the `ade:agent-chat:add-plan-annotation` CustomEvent.
 * Exposed separately so external callers (e.g. tests, or non-popover code
 * paths) can construct the payload without mounting the popover.
 */
export function dispatchOrchestrationAnnotation(
  detail: OrchestrationAnnotationEventDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OrchestrationAnnotationEventDetail>(
      ORCHESTRATION_ANNOTATION_EVENT,
      { detail },
    ),
  );
}

export function AnnotationPopover({
  runId,
  sessionId,
  anchor,
  onClose,
  onSubmit,
  position,
  mountTarget,
}: AnnotationPopoverProps) {
  const [comment, setComment] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const portalTarget = useMemo(() => {
    if (mountTarget) return mountTarget;
    return typeof document !== "undefined" ? document.body : null;
  }, [mountTarget]);

  // Focus the input on mount and select all (no existing text yet, but ready
  // for typing).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(() => {
    const trimmedComment = comment.trim();
    // Allow anchor-only submits (no comment) so the user can pin context
    // without typing. The lead still gets the selection excerpt.
    const item: OrchestrationContextItem = {
      type: "orchestration_annotation",
      runId,
      anchor: {
        kind: anchor.kind,
        ...(anchor.id ? { id: anchor.id } : {}),
        preview: anchor.preview,
        ...(anchor.href ? { href: anchor.href } : {}),
        ...(anchor.sectionId ? { sectionId: anchor.sectionId } : {}),
      },
      selectionExcerpt: anchor.selectionExcerpt ?? "",
      comment: trimmedComment,
      capturedAt: new Date().toISOString(),
    };
    // Dispatch with empty sessionId when no active chat session so
    // listeners can still surface a diagnostic. The composer listener only
    // merges when sessionId matches its own pane.
    dispatchOrchestrationAnnotation({ sessionId: sessionId ?? "", item });
    onSubmit?.(item);
    onClose();
  }, [comment, anchor, runId, sessionId, onSubmit, onClose]);

  // Dismiss on Escape; submit on Enter (Shift+Enter = newline).
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [onClose, submit],
  );

  // Click-outside dismissal. We only register the listener when the popover
  // is mounted; useEffect cleanup tears it down.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handlePointerDown = (event: globalThis.MouseEvent | globalThis.PointerEvent): void => {
      const node = containerRef.current;
      if (!node) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && node.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  const placement = useMemo<CSSProperties>(() => {
    const origin = position?.origin;
    if (origin) {
      return {
        position: "fixed",
        left: clampHorizontal(origin.x),
        top: clampVertical(origin.y + 8),
        zIndex: 110,
      };
    }
    const rect = position?.anchorRect;
    if (rect) {
      return {
        position: "fixed",
        left: clampHorizontal(rect.left),
        top: clampVertical(rect.bottom + 6),
        zIndex: 110,
      };
    }
    // Default: viewport centre, slightly above middle.
    return {
      position: "fixed",
      left: "50%",
      top: "30%",
      transform: "translateX(-50%)",
      zIndex: 110,
    };
  }, [position]);

  if (!portalTarget) return null;

  const previewLines = anchor.preview.split("\n").slice(0, 3);
  const previewText = previewLines.join("\n");

  const card = (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Add annotation"
      data-testid="orchestration-annotation-popover"
      data-annotation-kind={anchor.kind}
      style={{ ...placement, width: POPOVER_WIDTH }}
      className="rounded-lg border border-white/[0.08] bg-[#0E0C16]/96 p-3 shadow-[0_20px_48px_rgba(0,0,0,0.55)] backdrop-blur-sm"
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className={cn(
            "inline-flex h-5 items-center rounded-sm px-1.5 font-mono text-[9px] font-bold uppercase tracking-wider",
            "border border-violet-300/22 bg-violet-500/8 text-violet-100/85",
          )}
        >
          {anchor.kind}
        </span>
        <span className="font-sans text-[10.5px] uppercase tracking-wider text-muted-fg/55">
          Annotate
        </span>
      </div>
      {previewText.length ? (
        <div
          className="mb-2 max-h-24 overflow-hidden rounded-md border border-white/[0.05] bg-black/30 px-2 py-1.5 font-mono text-[10.5px] leading-snug text-fg/65"
          title={anchor.preview}
        >
          {previewText}
          {anchor.preview.length > previewText.length ? "…" : ""}
        </div>
      ) : null}
      <textarea
        ref={inputRef}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Comment (Enter to inject, Shift+Enter for newline, Esc to dismiss)"
        rows={3}
        className="w-full resize-none rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1.5 font-sans text-[11.5px] text-fg/90 outline-none placeholder:text-muted-fg/40 focus:border-violet-400/35"
        style={{ minHeight: POPOVER_MIN_INPUT_HEIGHT }}
      />
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-white/[0.08] px-2.5 py-1 font-sans text-[11px] text-fg/55 transition-colors hover:bg-white/[0.05] hover:text-fg/85"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="orchestration-annotation-submit"
          onClick={submit}
          className="rounded-md border border-violet-400/35 bg-violet-500/15 px-2.5 py-1 font-sans text-[11px] font-medium text-violet-50 transition-colors hover:bg-violet-500/22"
        >
          Inject
        </button>
      </div>
    </div>
  );

  return createPortal(card, portalTarget);
}

/**
 * Hook returned to OrchestrationPanel (or any other host) for opening the
 * popover programmatically. Encapsulates the open/close state so callers
 * can wire selection events without owning a useState pair.
 */
export type AnnotationPopoverController = {
  open: (anchor: AnnotationPopoverAnchor, position?: AnnotationPopoverPosition) => void;
  close: () => void;
  isOpen: boolean;
  anchor: AnnotationPopoverAnchor | null;
  position: AnnotationPopoverPosition | null;
};

export function useAnnotationPopoverController(): AnnotationPopoverController {
  const [anchor, setAnchor] = useState<AnnotationPopoverAnchor | null>(null);
  const [position, setPosition] = useState<AnnotationPopoverPosition | null>(null);

  const open = useCallback(
    (nextAnchor: AnnotationPopoverAnchor, nextPosition?: AnnotationPopoverPosition) => {
      setAnchor(nextAnchor);
      setPosition(nextPosition ?? null);
    },
    [],
  );
  const close = useCallback(() => {
    setAnchor(null);
    setPosition(null);
  }, []);

  return { open, close, anchor, position, isOpen: anchor != null };
}

/**
 * Convenience: capture the current `window.getSelection()` text and open
 * the popover with a `text` anchor. Returns true when a non-empty
 * selection was found.
 */
export function openAnnotationFromTextSelection(
  controller: AnnotationPopoverController,
  options?: { previewMaxLength?: number; sectionId?: string | null },
): boolean {
  if (typeof window === "undefined") return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  const text = selection.toString().trim();
  if (!text.length) return false;
  const previewMax = options?.previewMaxLength ?? 240;
  const preview = text.length > previewMax ? `${text.slice(0, previewMax - 1)}…` : text;
  let rect: DOMRect | null = null;
  if (selection.rangeCount > 0) {
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch {
      rect = null;
    }
  }
  controller.open(
    {
      kind: "text",
      preview,
      selectionExcerpt: text,
      ...(options?.sectionId ? { sectionId: options.sectionId } : {}),
    },
    rect ? { anchorRect: rect } : undefined,
  );
  return true;
}
