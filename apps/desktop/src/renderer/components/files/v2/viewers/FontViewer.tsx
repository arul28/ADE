import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, CaretDown, CaretRight, Check, TextAa } from "@phosphor-icons/react";
import { showToast } from "../../../app/toast/toastStore";
import { COLORS, fgTint } from "../../../lanes/laneDesignTokens";
import { formatBytes } from "../../../../../shared/formatting";
import { isWebClientMode } from "../../../../lib/webClientMode";
import { Banner } from "../../../ui/notice";
import { streamFileBytes } from "../streamBytes";
import { DocumentSurface } from "./DocumentSurface";
import {
  FONT_CODEPOINT_CAP,
  readFontInfo,
  type FontAxis,
  type FontInfo,
} from "./fontInfo";
import type { ViewerProps } from "./types";

const MAX_FONT_BYTES = 10 * 1024 * 1024;
const WATERFALL_SIZES = [12, 16, 20, 24, 32, 48, 64, 96];
const SAMPLE = "Sphinx of black quartz, judge my vow.";
const GLYPHS_PER_PAGE = 128;
const BLOCKS = [
  { name: "Basic Latin", start: 0x20, end: 0x7e },
  { name: "Latin-1", start: 0xa0, end: 0xff },
  { name: "Latin Extended", start: 0x100, end: 0x24f },
  { name: "Greek", start: 0x370, end: 0x3ff },
  { name: "Cyrillic", start: 0x400, end: 0x52f },
  { name: "Hebrew", start: 0x590, end: 0x5ff },
  { name: "Arabic", start: 0x600, end: 0x6ff },
  { name: "General punctuation", start: 0x2000, end: 0x206f },
  { name: "Symbols", start: 0x20a0, end: 0x2bff },
];

type GlyphGroup = { name: string; points: number[] };

function fileStem(path: string): string {
  const fileName = path.split(/[\\/]/).pop() || path;
  const extensionIndex = fileName.lastIndexOf(".");
  return extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
}

function familyLabel(info: FontInfo, fallbackName: string): string {
  return info.names.family || info.names.fullName || fallbackName;
}

function styleLabel(info: FontInfo): string {
  const style = info.names.subfamily || (info.italic ? "Italic" : "Regular");
  return info.weight ? `${style} · ${info.weight}` : style;
}

function codepointLabel(codepoint: number): string {
  const digits = codepoint <= 0xffff ? 4 : 6;
  return `U+${codepoint.toString(16).toUpperCase().padStart(digits, "0")}`;
}

function InfoField({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;

  return (
    <div className="min-w-0">
      <div className="text-[10px]" style={{ color: COLORS.textDim }}>{label}</div>
      <div className="break-words text-xs" style={{ color: COLORS.textSecondary }}>{value}</div>
    </div>
  );
}

function AxisSlider({
  axis,
  value,
  onChange,
}: {
  axis: FontAxis;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label
      className="flex min-w-0 items-center gap-2 text-[11px]"
      style={{ color: COLORS.textMuted }}
      title={`${axis.tag}: ${axis.min}–${axis.max}`}
    >
      <span className="w-8 shrink-0 font-mono">{axis.tag}</span>
      <input
        aria-label={`${axis.tag} axis`}
        type="range"
        min={axis.min}
        max={axis.max}
        step={(axis.max - axis.min) / 200 || 1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-w-0 flex-1 accent-[var(--color-accent)]"
      />
      <span className="w-12 text-right tabular-nums">{Number(value.toFixed(1))}</span>
    </label>
  );
}

/** Shows the loaded typeface name, style, size, and format controls. */
function FontHeader({
  info,
  size,
  family,
  fallbackName,
  rootPath,
  relativePath,
}: {
  info: FontInfo;
  size: number;
  family: string;
  fallbackName: string;
  rootPath: string;
  relativePath: string;
}) {
  const openExternally = () => {
    void window.ade.app.openPathInEditor?.({ rootPath, relativePath, target: "default" }).catch((error: unknown) => {
      console.warn("[FontViewer] open externally failed", error);
    });
  };
  const title = familyLabel(info, fallbackName);
  const fontStyle: React.CSSProperties = { fontFamily: `"${family}", sans-serif` };
  const containerSummary = info.containerSize
    ? formatBytes(info.containerSize)
    : "unknown expanded size";

  return (
    <section className="min-w-0">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2" style={{ borderColor: COLORS.border }}>
        <TextAa size={16} color={COLORS.accent} />
        <span className="min-w-0 flex-1 truncate text-xs" style={{ color: COLORS.textMuted }}>
          {info.format} font · {formatBytes(size)}
        </span>
        {/* The web client has no OS to open the file in, so it hides this instead of no-oping. */}
        {isWebClientMode() ? null : (
          <button
            type="button"
            onClick={openExternally}
            title="Open externally"
            className="rounded p-1 hover:bg-fg/5"
            style={{ color: COLORS.textMuted }}
          >
            <ArrowSquareOut size={14} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-2 pt-4">
        <div className="min-w-0">
          <h1
            className="break-words text-3xl leading-tight sm:text-4xl"
            style={{ ...fontStyle, color: COLORS.textPrimary }}
          >
            {title}
          </h1>
          <div className="mt-1 text-xs" style={{ color: COLORS.textMuted }}>
            {styleLabel(info)}
            {info.glyphCount != null ? ` · ${info.glyphCount.toLocaleString()} glyphs` : ""}
            {info.collectionCount ? ` · 1 of ${info.collectionCount}` : ""}
          </div>
        </div>
        <span
          className="rounded-full border px-2 py-1 text-[10px]"
          style={{ borderColor: COLORS.border, color: COLORS.textMuted }}
        >
          {info.format}
        </span>
      </div>
      {info.containerOnly ? (
        <Banner
          layout="inline"
          style={{ marginTop: 12 }}
          model={{
            id: "woff2-container",
            tone: "info",
            title: "Font details aren't available for WOFF2",
            detail: `The preview uses the browser's font engine. Container: ${info.containerTableCount ?? "?"} tables, ${containerSummary}.`,
          }}
        />
      ) : null}
    </section>
  );
}

/** Edits sample text and type size, with one control for each variable axis. */
function SampleCard({
  sample,
  onSampleChange,
  sampleSize,
  onSampleSizeChange,
  axes,
  axisValues,
  onAxisChange,
  family,
  faceReady,
}: {
  sample: string;
  onSampleChange: (value: string) => void;
  sampleSize: number;
  onSampleSizeChange: (value: number) => void;
  axes: FontAxis[];
  axisValues: Record<string, number>;
  onAxisChange: (tag: string, value: number) => void;
  family: string;
  faceReady: boolean;
}) {
  const variationSettings = Object.entries(axisValues)
    .map(([tag, value]) => `"${tag}" ${value}`)
    .join(", ");
  const fontStyle: React.CSSProperties = {
    fontFamily: `"${family}", sans-serif`,
    fontVariationSettings: variationSettings || undefined,
  };

  return (
    <section
      className="rounded-lg border p-3 sm:p-4"
      style={{ borderColor: COLORS.border, background: COLORS.cardBg }}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Sample text</span>
          <input
            value={sample}
            maxLength={2048}
            onChange={(event) => onSampleChange(event.target.value)}
            className={`w-full rounded-md border bg-transparent px-2.5 py-2 text-sm outline-none
              focus:border-[var(--color-accent)]`}
            style={{ borderColor: COLORS.border, color: COLORS.textPrimary }}
            placeholder="Type sample text"
          />
        </label>
        <label
          className="flex w-32 items-center gap-2 text-[11px]"
          style={{ color: COLORS.textMuted }}
          title="Sample size"
        >
          <span className="shrink-0">{sampleSize}px</span>
          <input
            aria-label="Sample size"
            type="range"
            min="10"
            max="160"
            value={sampleSize}
            onChange={(event) => onSampleSizeChange(Number(event.target.value))}
            className="min-w-0 flex-1 accent-[var(--color-accent)]"
          />
        </label>
      </div>
      {axes.length ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {axes.map((axis) => (
            <AxisSlider
              key={axis.tag}
              axis={axis}
              value={axisValues[axis.tag] ?? axis.default}
              onChange={(value) => onAxisChange(axis.tag, value)}
            />
          ))}
        </div>
      ) : null}
      <div
        className="mt-4 min-h-14 break-words"
        style={{ ...fontStyle, fontSize: sampleSize, lineHeight: 1.3, color: COLORS.textPrimary }}
      >
        {faceReady ? (sample || "Type sample text") : "Loading font…"}
      </div>
    </section>
  );
}

/** Compares the editable sample at the standard font preview sizes. */
function Waterfall({ sample, family }: { sample: string; family: string }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-medium" style={{ color: COLORS.textMuted }}>Size waterfall</h2>
      <div className="overflow-hidden rounded-lg border" style={{ borderColor: COLORS.border }}>
        {WATERFALL_SIZES.map((size) => (
          <div
            key={size}
            className="flex min-w-0 items-baseline gap-3 border-b px-3 py-2 last:border-0"
            style={{ borderColor: COLORS.borderMuted }}
          >
            <span className="w-8 shrink-0 text-[10px] tabular-nums" style={{ color: COLORS.textDim }}>
              {size}
            </span>
            <span
              className="min-w-0 truncate"
              style={{
                fontFamily: `"${family}", sans-serif`,
                fontSize: size,
                lineHeight: 1.25,
                color: COLORS.textPrimary,
              }}
            >
              {sample || "Font preview"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** One grid cell copies its character and briefly shows local confirmation. */
function GlyphButton({ codepoint, family }: { codepoint: number; family: string }) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
  }, []);

  const copy = async () => {
    const writeClipboardText = window.ade.app.writeClipboardText;
    if (!writeClipboardText) throw new Error("Clipboard access is unavailable.");
    await writeClipboardText(String.fromCodePoint(codepoint));
    setCopied(true);
    if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1000);
  };

  return (
    <button
      type="button"
      onClick={() => void copy().catch((error: unknown) => showToast({
        tone: "error",
        title: "Couldn't copy character",
        message: error instanceof Error ? error.message : String(error),
      }))}
      title={`${codepointLabel(codepoint)} · click to copy`}
      aria-label={copied ? `${codepointLabel(codepoint)} copied` : `Copy ${codepointLabel(codepoint)}`}
      className={`flex h-9 items-center justify-center rounded border text-xl hover:bg-fg/5
        focus-visible:outline focus-visible:outline-1`}
      style={{
        fontFamily: `"${family}", sans-serif`,
        borderColor: COLORS.border,
        color: COLORS.textPrimary,
      }}
    >
      {copied ? <Check size={16} weight="bold" /> : String.fromCodePoint(codepoint)}
    </button>
  );
}

/** Shows capped character coverage grouped into familiar Unicode blocks. */
function CharacterSet({
  groups,
  codepointCount,
  capped,
  shown,
  onShowMore,
  family,
  containerOnly,
}: {
  groups: GlyphGroup[];
  codepointCount: number;
  capped: boolean;
  shown: number;
  onShowMore: () => void;
  family: string;
  /**
   * WOFF2 coverage isn't parsed: show a fixed set of common characters, all
   * at once, with no count.
   */
  containerOnly: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const visibleLimit = containerOnly ? codepointCount : shown;
  let precedingPoints = 0;
  const visibleGroups = groups.map((group) => {
    const remaining = Math.max(0, visibleLimit - precedingPoints);
    precedingPoints += group.points.length;
    return { ...group, points: group.points.slice(0, remaining) };
  }).filter((group) => group.points.length);
  const shownCount = visibleGroups.reduce((total, group) => total + group.points.length, 0);
  const countLabel = capped
    ? `first ${FONT_CODEPOINT_CAP} shown (coverage cap)`
    : `${codepointCount} characters`;

  return (
    <section>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="mb-2 flex items-center gap-1 text-xs font-medium"
        style={{ color: COLORS.textMuted }}
      >
        {expanded ? <CaretDown size={13} /> : <CaretRight size={13} />}
        {containerOnly ? "Common characters" : "Character set"}
        {!containerOnly ? (
          <span className="font-normal" style={{ color: COLORS.textDim }}>
            ({countLabel})
          </span>
        ) : null}
      </button>
      {expanded ? (
        <>
          {containerOnly ? (
            <p className="mb-2 text-[11px]" style={{ color: COLORS.textDim }}>
              WOFF2 coverage isn't read in ADE; these render with the browser's fallback if missing.
            </p>
          ) : null}
          {groups.length ? (
            <div className="flex flex-col gap-3">
              {visibleGroups.map((group) => (
                <div key={group.name}>
                  <div className="mb-1 text-[10px]" style={{ color: COLORS.textDim }}>
                    {group.name}
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(34px,1fr))] gap-1">
                    {group.points.map((codepoint) => (
                      <GlyphButton key={codepoint} codepoint={codepoint} family={family} />
                    ))}
                  </div>
                </div>
              ))}
              {!containerOnly && shown < codepointCount ? (
                <button
                  type="button"
                  onClick={onShowMore}
                  className="self-start rounded-md border px-3 py-1.5 text-xs"
                  style={{ borderColor: COLORS.border, color: COLORS.textSecondary }}
                >
                  Show more characters ({shownCount} of {codepointCount})
                </button>
              ) : null}
            </div>
          ) : (
            <p className="text-xs" style={{ color: COLORS.textDim }}>
              Character coverage could not be read from this font.
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}

/** Presents name-table metadata and a clamped license with an expand control. */
function FontInfoSection({ info }: { info: FontInfo }) {
  const [licenseExpanded, setLicenseExpanded] = useState(false);

  return (
    <section className="border-t pt-4" style={{ borderColor: COLORS.border }}>
      <h2 className="mb-3 text-xs font-medium" style={{ color: COLORS.textMuted }}>Info</h2>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <InfoField label="Family" value={info.names.family} />
        <InfoField label="Subfamily" value={info.names.subfamily} />
        <InfoField label="Full name" value={info.names.fullName} />
        <InfoField label="Version" value={info.names.version} />
        <InfoField label="Weight class" value={info.weight ? String(info.weight) : null} />
        <InfoField label="Width class" value={info.width ? String(info.width) : null} />
        <InfoField label="Italic" value={info.italic == null ? null : info.italic ? "Yes" : "No"} />
        <InfoField label="Units per em" value={info.unitsPerEm?.toLocaleString() ?? null} />
        <InfoField label="Glyph count" value={info.glyphCount?.toLocaleString() ?? null} />
        <InfoField label="Designer" value={info.names.designer} />
        <InfoField label="Manufacturer" value={info.names.manufacturer} />
        <InfoField label="Copyright" value={info.names.copyright} />
      </div>
      {info.names.license ? (
        <div className="mt-3">
          <div className="text-[10px]" style={{ color: COLORS.textDim }}>License</div>
          <p
            className={`whitespace-pre-wrap break-words text-xs ${licenseExpanded ? "" : "line-clamp-3"}`}
            style={{ color: COLORS.textSecondary }}
          >
            {info.names.license}
          </p>
          {info.names.license.length > 180 ? (
            <button
              type="button"
              onClick={() => setLicenseExpanded((value) => !value)}
              className="mt-1 text-[10px] underline"
              style={{ color: COLORS.textMuted }}
            >
              {licenseExpanded ? "Show less" : "Show full license"}
            </button>
          ) : null}
        </div>
      ) : null}
      <InfoField label="License URL" value={info.names.licenseUrl} />
      {info.features.length ? (
        <div className="mt-3">
          <div className="mb-1 text-[10px]" style={{ color: COLORS.textDim }}>OpenType features</div>
          <div className="flex flex-wrap gap-1">
            {info.features.map((tag) => (
              <span
                key={tag}
                className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                style={{ background: fgTint(6), color: COLORS.textMuted }}
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Streams a font through the owning machine's Files API and previews it locally. */
export function FontViewer({ files, workspaceId, rootPath, tab, content }: ViewerProps) {
  const reactId = useId();
  const family = useMemo(
    () => `ADEFont_${tab.id.replace(/[^a-zA-Z0-9]/g, "")}_${reactId.replace(/[^a-zA-Z0-9]/g, "")}`,
    [reactId, tab.id],
  );
  const [info, setInfo] = useState<FontInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sample, setSample] = useState(SAMPLE);
  const [sampleSize, setSampleSize] = useState(32);
  const [axisValues, setAxisValues] = useState<Record<string, number>>({});
  const [shown, setShown] = useState(GLYPHS_PER_PAGE);
  const [faceReady, setFaceReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let loadedFace: FontFace | null = null;
    setInfo(null);
    setError(null);
    setLoading(true);
    setFaceReady(false);
    setAxisValues({});
    setShown(GLYPHS_PER_PAGE);

    // Reject by declared size before allocating the streamed buffer.
    if (content.size > MAX_FONT_BYTES) {
      setError(`This font is ${formatBytes(content.size)}. ADE previews fonts up to 10 MB.`);
      setLoading(false);
      return;
    }

    void (async () => {
      try {
        const bytes = await streamFileBytes(files, workspaceId, tab.path, {
          isCancelled: () => cancelled,
          maxBytes: MAX_FONT_BYTES,
        });
        if (cancelled) return;
        const parsed = await readFontInfo(bytes);
        if (cancelled) return;
        setInfo(parsed);

        const face = new FontFace(family, bytes);
        loadedFace = face;
        await face.load();
        if (cancelled) {
          document.fonts.delete(face);
          return;
        }
        document.fonts.add(face);
        setFaceReady(true);
        setAxisValues(Object.fromEntries(parsed.axes.map((axis) => [axis.tag, axis.default])));
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (loadedFace) document.fonts.delete(loadedFace);
    };
  }, [files, workspaceId, tab.id, tab.path, content.size, family]);

  const glyphGroups = useMemo(() => {
    if (!info) return [];
    if (info.containerOnly) {
      return BLOCKS.slice(0, 2).map((block) => ({
        name: block.name,
        points: Array.from(
          { length: block.end - block.start + 1 },
          (_, index) => block.start + index,
        ),
      }));
    }
    const remaining = new Set(info.codepoints);
    const groups = BLOCKS.map((block) => {
      const points = info.codepoints.filter((codepoint) => (
        codepoint >= block.start && codepoint <= block.end
      ));
      points.forEach((codepoint) => remaining.delete(codepoint));
      return { name: block.name, points };
    }).filter((group) => group.points.length);
    if (remaining.size) {
      groups.push({ name: "Other characters", points: [...remaining].sort((a, b) => a - b) });
    }
    return groups;
  }, [info]);
  const gridCodepointCount = glyphGroups.reduce((total, group) => total + group.points.length, 0);

  if (loading && !info) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: COLORS.textDim }}>
        Loading font preview…
      </div>
    );
  }
  if (error || !info) {
    return (
      <DocumentSurface
        rootPath={rootPath}
        relativePath={tab.path}
        title="ADE couldn't load this font"
        mimeType={content.mimeType ?? null}
        size={content.size}
        notice={error ?? "Font metadata is unavailable."}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
          <FontHeader
            info={info}
            size={content.size}
            family={family}
            fallbackName={fileStem(tab.path)}
            rootPath={rootPath}
            relativePath={tab.path}
          />
          <SampleCard
            sample={sample}
            onSampleChange={setSample}
            sampleSize={sampleSize}
            onSampleSizeChange={setSampleSize}
            axes={info.axes}
            axisValues={axisValues}
            onAxisChange={(tag, value) => setAxisValues((current) => ({ ...current, [tag]: value }))}
            family={family}
            faceReady={faceReady}
          />
          <Waterfall sample={sample} family={family} />
          <CharacterSet
            groups={glyphGroups}
            codepointCount={gridCodepointCount}
            capped={info.codepoints.length === FONT_CODEPOINT_CAP}
            shown={shown}
            onShowMore={() => setShown((count) => Math.min(info.codepoints.length, count + GLYPHS_PER_PAGE))}
            family={family}
            containerOnly={info.containerOnly}
          />
          <FontInfoSection info={info} />
        </div>
      </div>
    </div>
  );
}
