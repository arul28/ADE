import React from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { selectActiveProjectRoot, selectWorkViewState, useAppStore } from "../../state/appStore";
import { fgTint } from "../lanes/laneDesignTokens";
import { isImeComposing } from "../../lib/imeComposition";
import {
  activateEarlyComposer,
  decideEarlyComposer,
  EARLY_COMPOSER_SLOT_ATTRIBUTE,
  earlyComposerPendingKey,
  noteEarlyComposerComposing,
  noteEarlyComposerFocus,
  noteEarlyComposerPendingKey,
  noteEarlyComposerSelection,
  noteEarlyComposerText,
  startEarlyComposerKeyBuffer,
  WORK_ROUTE_ATTRIBUTE,
  type EarlyComposerLayout,
  type EarlyComposerPiece,
} from "../../lib/earlyComposer";

/*
 * The Work route's fallback while its chunk loads.
 *
 * Usually it is the chat-shaped skeleton it always was. When the view Work
 * will restore is an empty new chat on this computer and the new-chat screen
 * of an earlier launch was recorded for this window size and theme
 * (`lib/earlyComposer.ts`), it draws that screen instead, with a real text box
 * in the prompt box: a cold start can type before the composer's code exists.
 */

type Size = { width: number; height: number };
type Offset = { left: number; top: number };

function WorkLoadingSkeleton() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col" style={{ background: "var(--color-bg)" }} aria-label="Loading chats" aria-busy="true">
      <div className="flex h-12 shrink-0 items-center gap-3 px-5" style={{ borderBottom: "1px solid var(--color-border)" }}>
        <div className="h-3.5 w-56 animate-pulse rounded" style={{ background: fgTint(7) }} />
        <span className="ml-auto text-[11px] text-muted-fg/60">Loading chats…</span>
      </div>
      <div className="mx-auto flex min-h-0 w-full max-w-[52rem] flex-1 flex-col gap-5 px-6 pt-8">
        <div className="ml-auto h-14 w-2/3 animate-pulse rounded-2xl" style={{ background: fgTint(6) }} />
        <div className="space-y-2.5">
          {["w-11/12", "w-4/5", "w-3/5"].map((width) => (
            <div key={width} className={`h-3 ${width} animate-pulse rounded`} style={{ background: fgTint(5) }} />
          ))}
        </div>
        <div className="space-y-2.5">
          {["w-5/6", "w-2/3"].map((width) => (
            <div key={width} className={`h-3 ${width} animate-pulse rounded`} style={{ background: fgTint(5) }} />
          ))}
        </div>
      </div>
      <div className="mx-auto w-full max-w-[52rem] shrink-0 px-6 pb-5">
        <div className="h-[88px] animate-pulse rounded-2xl border border-border" style={{ background: fgTint(4) }} />
      </div>
    </div>
  );
}

/** CSS declarations as a React style object (custom properties stay as they are). */
function styleObject(declarations: Record<string, string>): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(declarations)) {
    if (name.startsWith("--")) {
      style[name] = value;
      continue;
    }
    const camel = name
      .replace(/^-webkit-/, "Webkit-")
      .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    style[camel] = value;
  }
  return style as React.CSSProperties;
}

function PieceFrame({
  piece,
  offset,
  shiftY = 0,
  fixedHeight = true,
  frameRef,
}: {
  piece: EarlyComposerPiece;
  offset: Offset;
  shiftY?: number;
  fixedHeight?: boolean;
  frameRef?: React.Ref<HTMLDivElement>;
}) {
  // Stable, so React writes the markup once and never touches it again (the
  // text box is a portal inside it).
  const markup = React.useMemo(() => ({ __html: piece.html }), [piece.html]);
  return (
    <div
      ref={frameRef}
      {...piece.scopeAttributes}
      style={{
        ...styleObject(piece.scopeStyle),
        position: "absolute",
        left: piece.rect.left - offset.left,
        top: piece.rect.top - offset.top + shiftY,
        width: piece.rect.width,
        ...(fixedHeight ? { height: piece.rect.height } : {}),
      }}
      dangerouslySetInnerHTML={markup}
    />
  );
}

function EarlyNewChatScreen({
  layout,
  projectRoot,
  offset,
}: {
  layout: EarlyComposerLayout;
  projectRoot: string;
  offset: Offset;
}) {
  const composerFrameRef = React.useRef<HTMLDivElement>(null);
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  const unmountingRef = React.useRef(false);
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);
  // The new-chat column is centred, so a taller prompt box moves it up by half
  // of what it grew, as the real one does.
  const [shiftY, setShiftY] = React.useState(0);

  React.useLayoutEffect(() => {
    const found = composerFrameRef.current?.querySelector<HTMLElement>(`[${EARLY_COMPOSER_SLOT_ATTRIBUTE}]`) ?? null;
    setSlot(found);
  }, []);

  const measure = React.useCallback(() => {
    const field = textRef.current;
    if (!field) return;
    const grown = field.getBoundingClientRect().height - layout.text.height;
    const next = Math.round((-grown / 2) * 100) / 100;
    setShiftY((current) => (Math.abs(current - next) < 0.01 ? current : next));
  }, [layout.text.height]);

  const recordText = React.useCallback(() => {
    const field = textRef.current;
    if (!field) return;
    noteEarlyComposerText(field.value, field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length);
  }, []);

  React.useLayoutEffect(() => {
    const field = textRef.current;
    if (!slot || !field) return undefined;
    // The real field's own box, text styles and attributes (`dir`, spell check,
    // the layout variant some CSS reads), as recorded.
    field.style.cssText = layout.text.style;
    for (const [name, value] of Object.entries(layout.text.attributes)) {
      if (!field.hasAttribute(name)) field.setAttribute(name, value);
    }
    activateEarlyComposer(projectRoot);
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
      field.focus({ preventScroll: true });
    }
    noteEarlyComposerFocus(document.activeElement === field);
    measure();
    // After an early Enter the box holds still: the text that Enter sends is
    // the text it was pressed on.
    const holdAfterEnter = (event: InputEvent) => {
      if (earlyComposerPendingKey() && event.cancelable) event.preventDefault();
    };
    field.addEventListener("beforeinput", holdAfterEnter);
    return () => {
      field.removeEventListener("beforeinput", holdAfterEnter);
      // Runs before the box leaves the page. A composition the Work route
      // stopped waiting for ends here, with what the field shows.
      unmountingRef.current = true;
      noteEarlyComposerComposing(false);
      noteEarlyComposerText(field.value, field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length);
      if (document.activeElement === field) {
        noteEarlyComposerFocus(true);
        startEarlyComposerKeyBuffer();
      }
    };
  }, [layout.text.attributes, layout.text.style, measure, projectRoot, slot]);

  const textField = slot ? createPortal(
    <textarea
      ref={textRef}
      data-ade-early-composer=""
      className={layout.text.className}
      placeholder={layout.text.placeholder}
      defaultValue=""
      onInput={() => {
        recordText();
        measure();
      }}
      onSelect={() => {
        const field = textRef.current;
        if (field) noteEarlyComposerSelection(field.selectionStart ?? 0, field.selectionEnd ?? 0);
      }}
      onFocus={() => {
        if (!unmountingRef.current) noteEarlyComposerFocus(true);
      }}
      onBlur={() => {
        if (!unmountingRef.current) noteEarlyComposerFocus(false);
      }}
      onCompositionStart={() => noteEarlyComposerComposing(true)}
      onCompositionEnd={() => {
        noteEarlyComposerComposing(false);
        recordText();
        measure();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
        if (isImeComposing(event)) return;
        // Enter (or ⌘/Ctrl+Enter) is not typed here. The real composer gets
        // the same key after the hand-over and decides: send, or a new line.
        event.preventDefault();
        if (earlyComposerPendingKey()) return;
        recordText();
        noteEarlyComposerPendingKey({ metaKey: event.metaKey, ctrlKey: event.ctrlKey });
      }}
    />,
    slot,
  ) : null;

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: layout.routeBackground || undefined }}>
      <div
        className="absolute overflow-hidden"
        style={{
          left: layout.surface.left - offset.left,
          top: layout.surface.top - offset.top,
          width: layout.surface.width,
          height: layout.surface.height,
        }}
      >
        {/* The flat form of the new-chat backdrop, which is also the first
            paint of the real one (`WorkToolPickerBackdrop`). */}
        <div aria-hidden="true" className="ade-tool-picker-backdrop" data-field="window">
          <div className="ade-tool-picker-static absolute inset-0" />
        </div>
      </div>
      {layout.pills ? <PieceFrame piece={layout.pills} offset={offset} /> : null}
      {layout.wordmark ? <PieceFrame piece={layout.wordmark} offset={offset} shiftY={shiftY} /> : null}
      <PieceFrame
        piece={layout.composer}
        offset={offset}
        shiftY={shiftY}
        fixedHeight={false}
        frameRef={composerFrameRef}
      />
      {textField}
    </div>
  );
}

/**
 * The Work route's Suspense fallback. `shown` is false for a project surface
 * that is parked behind another tab.
 */
export function WorkLoadingFallback({ shown }: { shown: boolean }) {
  const location = useLocation();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = React.useState<{ size: Size; offset: Offset } | null>(null);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const bindingKind = useAppStore((s) => s.projectBinding?.kind ?? null);
  const activeItemId = useAppStore((s) => selectWorkViewState(projectRoot)(s).activeItemId);
  const activeGridSetId = useAppStore((s) => selectWorkViewState(projectRoot)(s).activeGridSetId);
  const draftKind = useAppStore((s) => selectWorkViewState(projectRoot)(s).draftKind);
  const draftMachineId = useAppStore((s) => selectWorkViewState(projectRoot)(s).draftMachineId);
  const draftOnCloud = useAppStore((s) => selectWorkViewState(projectRoot)(s).draftCloudTarget != null);
  const laneCount = useAppStore((s) => s.lanes.length);
  const chatFontSizePx = useAppStore((s) => s.chatFontSizePx);
  // Once the early box is on screen it stays until the Work page replaces it,
  // so text the person typed never turns back into a skeleton.
  const [heldLayout, setHeldLayout] = React.useState<EarlyComposerLayout | null>(null);

  React.useLayoutEffect(() => {
    const measure = () => {
      const root = rootRef.current;
      const route = root?.closest(`[${WORK_ROUTE_ATTRIBUTE}]`);
      if (!root || !route) return;
      const routeRect = route.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const next = {
        size: { width: routeRect.width, height: routeRect.height },
        offset: { left: rootRect.left - routeRect.left, top: rootRect.top - routeRect.top },
      };
      setGeometry((current) => (
        current
        && current.size.width === next.size.width
        && current.size.height === next.size.height
        && current.offset.left === next.offset.left
        && current.offset.top === next.offset.top
          ? current
          : next
      ));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const decision = React.useMemo(() => decideEarlyComposer({
    shown: shown && location.pathname === "/work" && !location.search,
    projectRoot,
    bindingKind,
    view: {
      activeItemId,
      activeGridSetId,
      draftKind,
      draftMachineId,
      draftCloudTarget: draftOnCloud ? true : null,
    },
    laneCount,
    chatFontSizePx,
    route: geometry?.size ?? null,
  }), [
    activeGridSetId,
    activeItemId,
    bindingKind,
    chatFontSizePx,
    draftKind,
    draftMachineId,
    draftOnCloud,
    geometry,
    laneCount,
    location.pathname,
    location.search,
    projectRoot,
    shown,
  ]);

  const layout = heldLayout ?? (decision.ok ? decision.layout : null);
  React.useEffect(() => {
    if (layout && !heldLayout) setHeldLayout(layout);
  }, [heldLayout, layout]);

  return (
    <div ref={rootRef} className="h-full min-h-0 w-full">
      {layout && projectRoot && geometry ? (
        <EarlyNewChatScreen layout={layout} projectRoot={projectRoot} offset={geometry.offset} />
      ) : (
        <WorkLoadingSkeleton />
      )}
    </div>
  );
}
