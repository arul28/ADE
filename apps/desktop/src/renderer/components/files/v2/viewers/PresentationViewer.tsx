import React, { useEffect, useMemo, useRef, useState } from "react";
import { CaretLeft, CaretRight, ListBullets, Presentation } from "@phosphor-icons/react";
import { COLORS, fgTint } from "../../../lanes/laneDesignTokens";
import { captureError } from "../../../../../shared/sentry/capture";
import type { PptxBox, PptxDeck, PptxParagraph, PptxRun, PptxShape, PptxSlide } from "./office/pptx";
import { OoxmlPreviewShell } from "./OoxmlPreviewShell";
import { ViewerModeToggleButton } from "./ViewerModeToggle";
import { readViewerMode, rememberViewerMode } from "./viewerModeMemory";
import type { ViewerProps } from "./types";

/** Same ceiling as the PDF and spreadsheet viewers. */
const MAX_PRESENTATION_STREAM_BYTES = 25 * 1024 * 1024;
/**
 * The canvas never shrinks below this, even in a narrow tools pane: a slide
 * that fits a 140px column is technically correct and completely unreadable,
 * so past this width the pane scrolls instead of the type shrinking.
 */
const MIN_SLIDE_WIDTH_PX = 360;
/** Default print size for runs the deck does not size itself. */
const DEFAULT_TITLE_PT = 30;
const DEFAULT_BODY_PT = 16;
/** A slide is a page: its own white, not the app theme's surface. */
const SLIDE_BACKGROUND = "#ffffff";
const SLIDE_INK = "#1f1f1f";
const SLIDE_INK_MUTED = "#6b6b6b";

type Mode = "canvas" | "outline";

/**
 * `.pptx` preview: slide rail, canvas, and an outline view, with the deck's
 * own text, pictures and tables laid out from their real EMU coordinates.
 *
 * Two properties matter beyond drawing something. **Scoped navigation**: the
 * arrow keys are handled on this component's own surface, so pressing Left in
 * the composer beside it cannot flip a slide — the reference implementation
 * listened on `window` and did exactly that. **Owned media**: each slide's
 * pictures get object URLs inside one effect, which revokes exactly what it
 * created when the slide changes or the viewer unmounts.
 */
export function PresentationViewer(props: ViewerProps) {
  const { files, workspaceId, tab, rootPath, content } = props;
  const declaredSize = content.totalSize ?? content.size;

  return (
    <OoxmlPreviewShell<PptxDeck>
      files={files}
      workspaceId={workspaceId}
      path={tab.path}
      byteCap={MAX_PRESENTATION_STREAM_BYTES}
      declaredSize={declaredSize}
      loadingLabel={`Loading ${tab.title}…`}
      fallback={{ rootPath, title: tab.title, mimeType: content.mimeType ?? null, size: content.size }}
      load={async (bytes) => {
        // Imported on demand: the deck reader is not on the Files route.
        const { openPptx } = await import("./office/pptx");
        return openPptx(bytes);
      }}
    >
      {(deck) => <DeckViewer deck={deck} tabId={tab.id} />}
    </OoxmlPreviewShell>
  );
}

function DeckViewer({ deck, tabId }: { deck: PptxDeck; tabId: string }) {
  const [slideIndex, setSlideIndex] = useState(0);
  const [storedMode, setStoredMode] = useState<Mode>(() => readViewerMode<Mode>(tabId, "canvas"));
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const setMode = (mode: Mode) => {
    rememberViewerMode(tabId, mode);
    setStoredMode(mode);
  };

  const slides = deck.slides;
  const slide = slides[slideIndex] ?? null;
  const aspect = deck.slideWidthEmu / deck.slideHeightEmu;

  // Pictures for the current slide only. The URLs belong to this effect
  // invocation: whoever created them revokes them, including when the parse
  // was cancelled after the read landed but before the slide was drawn.
  const [mediaUrls, setMediaUrls] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    setMediaUrls(new Map());
    if (!slide) return;
    let cancelled = false;
    const createdUrls: string[] = [];
    (async () => {
      const next = new Map<string, string>();
      const paths = Array.from(new Set(
        slide.shapes
          .filter(isPictureWithMedia)
          .map((shape) => shape.mediaPath),
      ));
      for (const path of paths) {
        let media: Awaited<ReturnType<PptxDeck["loadMedia"]>>;
        try {
          media = await deck.loadMedia(path);
        } catch {
          media = null; // past the media cap — the slide counts it as not shown
        }
        if (cancelled) return;
        if (!media) continue;
        const url = URL.createObjectURL(new Blob([media.bytes], { type: media.mimeType }));
        createdUrls.push(url);
        next.set(path, url);
      }
      if (cancelled) return;
      setMediaUrls(next);
    })().catch((err: unknown) => {
      // A recovered failure still has to be visible to Sentry (docs/logging.md).
      captureError(err, {
        handled: true,
        tags: { feature: "files.presentation_preview", stage: "media" },
        fingerprint: ["files.presentation_preview", "media"],
      });
    });
    return () => {
      cancelled = true;
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [deck, slide]);

  const noticesLine = useMemo(() => (slide ? describeSlideNotices(slide) : null), [slide]);

  const move = (delta: number) => {
    setSlideIndex((index) => Math.max(0, Math.min(slides.length - 1, index + delta)));
  };

  return (
    // The keydown handler lives here, not on `window`: keys only reach it
    // while focus is inside this viewer.
    <div
      ref={surfaceRef}
      tabIndex={0}
      className="flex h-full min-h-0 flex-col outline-none"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "PageUp") move(-1);
        else if (event.key === "ArrowRight" || event.key === "PageDown") move(1);
        else if (event.key === "Home") setSlideIndex(0);
        else if (event.key === "End") setSlideIndex(slides.length - 1);
        else return;
        event.preventDefault();
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: COLORS.border }}>
        <Presentation size={14} style={{ color: COLORS.textDim }} />
        <span className="text-xs" style={{ color: COLORS.textMuted }}>
          {slides.length} slide{slides.length === 1 ? "" : "s"}
        </span>
        <div className="mx-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => move(-1)}
            disabled={slideIndex <= 0}
            aria-label="Previous slide"
            className="rounded p-1 hover:bg-fg/5 disabled:opacity-40"
          >
            <CaretLeft size={14} />
          </button>
          <span className="w-16 text-center text-xs tabular-nums" style={{ color: COLORS.textMuted }}>
            {slides.length > 0 ? `${slideIndex + 1} / ${slides.length}` : "—"}
          </span>
          <button
            type="button"
            onClick={() => move(1)}
            disabled={slideIndex >= slides.length - 1}
            aria-label="Next slide"
            className="rounded p-1 hover:bg-fg/5 disabled:opacity-40"
          >
            <CaretRight size={14} />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <ViewerModeToggleButton active={storedMode === "canvas"} onClick={() => setMode("canvas")} icon={<Presentation size={13} />} label="Slides" />
          <ViewerModeToggleButton active={storedMode === "outline"} onClick={() => setMode("outline")} icon={<ListBullets size={13} />} label="Outline" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {storedMode === "canvas" ? (
          <>
            <SlideRail slides={slides} slideIndex={slideIndex} onSelect={setSlideIndex} />
            <div className="flex min-w-0 min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
                {slide ? (
                  <SlideCanvas
                    slide={slide}
                    aspect={aspect}
                    slideWidthEmu={deck.slideWidthEmu}
                    mediaUrls={mediaUrls}
                  />
                ) : null}
              </div>
              {noticesLine || deck.truncated ? (
                <div className="shrink-0 border-t px-3 py-1 text-[11px]" style={{ borderColor: COLORS.border, color: COLORS.textDim }}>
                  {[noticesLine, deck.truncated ? `Showing the first ${slides.length} slides.` : null].filter(Boolean).join(" ")}
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <OutlineView slides={slides} slideIndex={slideIndex} onSelect={setSlideIndex} />
        )}
      </div>
    </div>
  );
}

/** `p:pic` whose media resolved to a part this viewer can draw. */
function isPictureWithMedia(shape: PptxShape): shape is PptxShape & { kind: "image"; mediaPath: string } {
  return shape.kind === "image" && shape.mediaPath !== null;
}

/** A shape the layout gave real geometry to. */
function isPositioned(shape: PptxShape): shape is PptxShape & { box: PptxBox } {
  return shape.box !== null;
}

function describeSlideNotices(slide: PptxSlide): string | null {
  const parts: string[] = [];
  if (slide.notices.charts > 0) parts.push(`${slide.notices.charts} chart${slide.notices.charts === 1 ? "" : "s"}`);
  if (slide.notices.media > 0) parts.push(`${slide.notices.media} media element${slide.notices.media === 1 ? "" : "s"}`);
  if (slide.notices.groups > 0) parts.push(`${slide.notices.groups} grouped shape${slide.notices.groups === 1 ? "" : "s"}`);
  if (slide.notices.pictures > 0) parts.push(`${slide.notices.pictures} picture${slide.notices.pictures === 1 ? "" : "s"}`);
  if (slide.notices.trimmedTables > 0) parts.push(`${slide.notices.trimmedTables} trimmed table${slide.notices.trimmedTables === 1 ? "" : "s"}`);
  if (parts.length === 0) return null;
  return `Not shown in this preview: ${parts.join(", ")}.`;
}

function SlideRail({
  slides,
  slideIndex,
  onSelect,
}: {
  slides: PptxSlide[];
  slideIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="flex w-44 shrink-0 flex-col overflow-y-auto border-r p-1.5" style={{ borderColor: COLORS.border, background: fgTint(2) }}>
      {slides.map((slide, index) => {
        const active = index === slideIndex;
        return (
          <button
            key={slide.index}
            type="button"
            onClick={() => onSelect(index)}
            className="mb-1 w-full shrink-0 rounded-md px-2 py-1.5 text-left"
            style={{ background: active ? fgTint(8) : "transparent" }}
          >
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-[10px] tabular-nums" style={{ color: COLORS.textDim }}>
                {slide.index}
              </span>
              <span className="truncate text-xs" style={{ color: active ? COLORS.textPrimary : COLORS.textMuted }}>
                {slide.title || "Untitled slide"}
              </span>
            </div>
            {slide.outline.length > 1 ? (
              <div className="mt-0.5 truncate pl-5 text-[10px]" style={{ color: COLORS.textDim }}>
                {slide.outline.slice(1).join(" · ")}
              </div>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function OutlineView({
  slides,
  slideIndex,
  onSelect,
}: {
  slides: PptxSlide[];
  slideIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto max-w-3xl space-y-3">
        {slides.map((slide, index) => (
          <button
            key={slide.index}
            type="button"
            onClick={() => onSelect(index)}
            className="block w-full rounded-lg border px-3 py-2 text-left"
            style={{
              borderColor: index === slideIndex ? COLORS.accentBorder : fgTint(6),
              background: index === slideIndex ? fgTint(4) : "transparent",
            }}
          >
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-[10px] tabular-nums" style={{ color: COLORS.textDim }}>
                Slide {slide.index}
              </span>
              <span className="truncate text-xs font-medium" style={{ color: COLORS.textPrimary }}>
                {slide.title || "Untitled slide"}
              </span>
            </div>
            <div className="space-y-0.5">
              {slide.outline.length > 0 ? (
                slide.outline.map((line, lineIndex) => (
                  <div key={lineIndex} className="truncate text-xs" style={{ color: COLORS.textMuted }}>
                    {line}
                  </div>
                ))
              ) : (
                <div className="text-xs italic" style={{ color: COLORS.textDim }}>
                  No text on this slide.
                </div>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One slide, drawn at the largest size that fits its pane. Sizes are measured
 * rather than expressed in CSS because a slide must preserve its own aspect
 * ratio against both a wide and a tall pane; a container-query unit keeps the
 * type proportional to the slide while the box resizes.
 */
function SlideCanvas({
  slide,
  aspect,
  slideWidthEmu,
  mediaUrls,
}: {
  slide: PptxSlide;
  aspect: number;
  slideWidthEmu: number;
  mediaUrls: Map<string, string>;
}) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const size = useFitSize(paneRef, aspect);

  const positioned = slide.shapes.filter(isPositioned);
  const flowing = slide.shapes.filter((shape) => !isPositioned(shape));
  const flowTop = positioned.length > 0
    ? Math.min(0.55, Math.max(...positioned.map((shape) => shape.box.y + shape.box.h)) + 0.02)
    : 0.06;

  return (
    <div ref={paneRef} className="flex h-full w-full items-center justify-center">
      <div
        data-presentation-slide={slide.index}
        style={{
          width: size.width,
          height: size.height,
          background: SLIDE_BACKGROUND,
          containerType: "inline-size",
          position: "relative",
          overflow: "hidden",
          borderRadius: 6,
          boxShadow: "0 2px 10px rgba(0,0,0,0.18)",
          color: SLIDE_INK,
        }}
      >
        {positioned.map((shape, index) => (
          <PositionedShape key={`p-${index}`} shape={shape} slideWidthEmu={slideWidthEmu} mediaUrls={mediaUrls} />
        ))}
        {flowing.length > 0 ? (
          <div
            style={{
              position: "absolute",
              left: "7%",
              right: "7%",
              top: `${flowTop * 100}%`,
              bottom: "6%",
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-start",
              gap: "2cqw",
              overflow: "hidden",
            }}
          >
            {flowing.map((shape, index) => (
              <FlowingShape key={`f-${index}`} shape={shape} slideWidthEmu={slideWidthEmu} mediaUrls={mediaUrls} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** EMU-relative font size expressed in container-query width units. */
function fontCqw(sizePt: number, slideWidthEmu: number): string {
  return `${((sizePt * 12_700) / slideWidthEmu) * 100}cqw`;
}

function PositionedShape({
  shape,
  slideWidthEmu,
  mediaUrls,
}: {
  shape: PptxShape & { box: PptxBox };
  slideWidthEmu: number;
  mediaUrls: Map<string, string>;
}) {
  const { box } = shape;
  return (
    <div
      style={{
        position: "absolute",
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.w * 100}%`,
        height: `${box.h * 100}%`,
        overflow: "hidden",
      }}
    >
      <ShapeBody shape={shape} slideWidthEmu={slideWidthEmu} mediaUrls={mediaUrls} />
    </div>
  );
}

function FlowingShape({
  shape,
  slideWidthEmu,
  mediaUrls,
}: {
  shape: PptxShape;
  slideWidthEmu: number;
  mediaUrls: Map<string, string>;
}) {
  if (shape.kind === "text") {
    return (
      <div style={{ flexShrink: 0 }}>
        <TextBody paragraphs={shape.paragraphs} isTitle={shape.isTitle} anchor={shape.anchor} slideWidthEmu={slideWidthEmu} />
      </div>
    );
  }
  return (
    <div style={{ height: "40cqw", flexShrink: 0 }}>
      <ShapeBody shape={shape} slideWidthEmu={slideWidthEmu} mediaUrls={mediaUrls} />
    </div>
  );
}

function ShapeBody({
  shape,
  slideWidthEmu,
  mediaUrls,
}: {
  shape: PptxShape;
  slideWidthEmu: number;
  mediaUrls: Map<string, string>;
}) {
  switch (shape.kind) {
    case "text":
      return <TextBody paragraphs={shape.paragraphs} isTitle={shape.isTitle} anchor={shape.anchor} slideWidthEmu={slideWidthEmu} />;
    case "table":
      return <TableBody rows={shape.rows} headerRow={shape.headerRow} />;
    case "image": {
      const url = shape.mediaPath ? mediaUrls.get(shape.mediaPath) ?? null : null;
      if (!url) {
        return (
          <div className="flex h-full w-full items-center justify-center text-[1.4cqw]" style={{ color: SLIDE_INK_MUTED, background: "#f3f3f3" }}>
            Image not shown
          </div>
        );
      }
      return <img src={url} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "contain" }} />;
    }
    default:
      return null;
  }
}

function TextBody({
  paragraphs,
  isTitle,
  anchor,
  slideWidthEmu,
}: {
  paragraphs: PptxParagraph[];
  isTitle: boolean;
  anchor: "top" | "middle" | "bottom";
  slideWidthEmu: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: anchor === "middle" ? "center" : anchor === "bottom" ? "flex-end" : "flex-start",
        gap: "0.4cqw",
        padding: "1.5%",
        height: "100%",
        width: "100%",
      }}
    >
      {paragraphs.map((paragraph, index) => {
        const sizePt = paragraphFontPt(paragraph, isTitle);
        return (
          <div
            key={index}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "0.9cqw",
              marginLeft: `${paragraph.level * 2.4}cqw`,
              textAlign: paragraph.align,
              justifyContent: paragraph.align === "center" ? "center" : paragraph.align === "right" ? "flex-end" : "flex-start",
            }}
          >
            {paragraph.bullet ? (
              <span style={{ fontSize: fontCqw(sizePt * 0.9, slideWidthEmu), color: SLIDE_INK }} aria-hidden>
                •
              </span>
            ) : null}
            <span style={{ flex: "0 1 auto", minWidth: 0 }}>
              {paragraph.runs.map((run, runIndex) => (
                <RunSpan key={runIndex} run={run} paragraphPt={sizePt} slideWidthEmu={slideWidthEmu} />
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RunSpan({
  run,
  paragraphPt,
  slideWidthEmu,
}: {
  run: PptxRun;
  paragraphPt: number;
  slideWidthEmu: number;
}) {
  return (
    <span
      style={{
        fontSize: fontCqw(run.sizePt ?? paragraphPt, slideWidthEmu),
        fontWeight: run.bold ? 600 : undefined,
        fontStyle: run.italic ? "italic" : undefined,
        textDecoration: run.underline ? "underline" : undefined,
        color: run.color ?? SLIDE_INK,
        lineHeight: 1.35,
      }}
    >
      {run.text}
    </span>
  );
}

function paragraphFontPt(paragraph: PptxParagraph, isTitle: boolean): number {
  const authored = paragraph.runs.find((run) => run.sizePt !== null)?.sizePt;
  if (authored) return authored;
  if (isTitle) return DEFAULT_TITLE_PT;
  return DEFAULT_BODY_PT - Math.min(paragraph.level, 3) * 1.5;
}

function TableBody({ rows, headerRow }: { rows: string[][]; headerRow: boolean }) {
  // A loop, not `Math.max(...rows.map(…))`: the parser bounds the rows, but a
  // spread over an unbounded array throws and takes the whole window down.
  let columnCount = 1;
  for (const row of rows) {
    if (row.length > columnCount) columnCount = row.length;
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
        fontSize: "1.35cqw",
        lineHeight: 1.3,
        borderTop: `1px solid ${SLIDE_INK_MUTED}`,
        borderLeft: `1px solid ${SLIDE_INK_MUTED}`,
        height: "100%",
        overflow: "hidden",
      }}
    >
      {rows.flatMap((row, rowIndex) =>
        Array.from({ length: columnCount }, (_unused, columnIndex) => {
          const header = headerRow && rowIndex === 0;
          return (
            <div
              key={`${rowIndex}-${columnIndex}`}
              style={{
                borderRight: `1px solid ${SLIDE_INK_MUTED}`,
                borderBottom: `1px solid ${SLIDE_INK_MUTED}`,
                padding: "0.6cqw 0.8cqw",
                fontWeight: header ? 600 : undefined,
                background: header ? "#f2f2f2" : "transparent",
                overflow: "hidden",
              }}
            >
              {row[columnIndex] ?? ""}
            </div>
          );
        }),
      )}
    </div>
  );
}

/** Largest box with `aspect` that fits the pane, never narrower than the readable floor. */
function useFitSize(paneRef: React.RefObject<HTMLElement | null>, aspect: number): { width: number; height: number } {
  const [size, setSize] = useState({ width: 640, height: 640 / aspect });
  useEffect(() => {
    const element = paneRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const availableWidth = Math.max(120, rect.width - 32);
      const availableHeight = Math.max(90, rect.height - 32);
      const width = Math.max(
        MIN_SLIDE_WIDTH_PX,
        Math.min(availableWidth, availableHeight * aspect, 1280),
      );
      setSize({ width, height: width / aspect });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [paneRef, aspect]);
  return size;
}
