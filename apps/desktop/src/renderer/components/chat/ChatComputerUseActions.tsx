/**
 * Computer-use action rows in the chat thread.
 *
 * An agent drives a screen through its shell tool (`ade screen click …`,
 * `ade browser fill …`). Those calls used to show only in the tools list as
 * shell commands. Here each one becomes a sentence naming what it acted on —
 * "Clicked “Checkout” on localhost:5173", "Pressed “Escape” in ADE" — in a
 * quiet run of rows on one grid: [action icon] [text] [status], all one small
 * size since this is background work. The latest action of a run stands out by
 * colour and any warning; earlier ones are one muted line. Only a warning or a
 * failure gets a mark, and a failure always says why. Identical actions in a
 * row merge into one line with a count ("Looked at ADE ×3"). A line with
 * pictures (the proof it filed, or the screenshot the agent then opened) is a
 * button: a click opens them small under it, and a click on one enlarges it.
 * The reader gets the turn's proof at its end, so pictures start closed.
 *
 * The words come from `shared/computerUseActionSummary.ts` and
 * `shared/computerUseActionPresentation.ts`, which the iOS app mirrors; which
 * entries are actions and how runs sit in the timeline is
 * `chatComputerUseRows.ts`. Every shell command the parser cannot describe
 * keeps its plain shell row.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  AppleLogo,
  ArrowsDownUp,
  Browser,
  Camera,
  CaretRight,
  CursorClick,
  DeviceMobile,
  Eye,
  Globe,
  HandGrabbing,
  HandTap,
  Hourglass,
  Keyboard,
  Monitor,
  Plugs,
  Seal,
  TextT,
  Warning,
  XCircle,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";

import {
  computerUseActionParts,
  computerUseActionText,
  computerUseOutcomeNote,
  layoutComputerUseRun,
  type ComputerUseRunLine,
  type ComputerUseSurfaceGlyph,
} from "../../../shared/computerUseActionPresentation";
import type { ComputerUseActionOutcome, ComputerUseActionSummary } from "../../../shared/computerUseActionSummary";
import type { InstalledBrowser } from "../../../shared/browserTargets";
import { cn } from "../ui/cn";
import { collectComputerUseActions, computerUseLinePictures, PROOF_THUMBNAIL_HEIGHT } from "./chatComputerUseRows";
import { ProofActionThumbnail } from "./ChatProofCitation";
import { ViewedImageStrip } from "./ChatViewedImages";
import type { ChatWorkLogEntry } from "./chatTranscriptRows";
import { isAdeAvailable } from "../../lib/adeAvailability";

/* ── App icons ───────────────────────────────────────────────────────────── */

/**
 * One lookup per app name per window, shared by every row. A miss is cached
 * too, so a row that has no icon never asks again.
 */
const appIconCache = new Map<string, string | null>();
const appIconInFlight = new Map<string, Promise<string | null>>();

function iconNameCandidates(name: string): string[] {
  const trimmed = name.trim();
  // "ADE (dev)" is ADE's window title; the app is "ADE".
  const bare = trimmed.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return [...new Set([trimmed, bare].filter(Boolean))];
}

async function lookupAppIcon(name: string): Promise<string | null> {
  const getAppIcon = window.ade?.app?.getAppIcon;
  if (!isAdeAvailable(getAppIcon)) return null;
  for (const candidate of iconNameCandidates(name)) {
    try {
      const url = await getAppIcon({ name: candidate });
      if (url) return url;
    } catch {
      // A failed read is the same as no icon.
    }
  }
  return null;
}

function requestAppIcon(name: string): Promise<string | null> {
  const key = name.trim().toLowerCase();
  const inFlight = appIconInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = lookupAppIcon(name).then((url) => {
    appIconCache.set(key, url);
    appIconInFlight.delete(key);
    return url;
  });
  appIconInFlight.set(key, promise);
  return promise;
}

function useAppIcon(name: string | null): string | null {
  const key = name?.trim().toLowerCase() ?? "";
  const [, setTick] = useState(0);
  const cached = key ? appIconCache.get(key) : null;
  useEffect(() => {
    if (!key || appIconCache.has(key)) return;
    let cancelled = false;
    void requestAppIcon(name!).then(() => {
      if (!cancelled) setTick((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [key, name]);
  return cached ?? null;
}

/** The user's browsers, read once per window: their real icons. */
let installedBrowsers: InstalledBrowser[] | null = null;
let installedBrowsersRequest: Promise<InstalledBrowser[]> | null = null;

function useInstalledBrowserIcon(browserName: string | null): string | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!browserName || installedBrowsers) return;
    const detector = window.ade?.app?.getInstalledBrowsers;
    if (!isAdeAvailable(detector)) return;
    let cancelled = false;
    installedBrowsersRequest ??= detector().catch(() => [] as InstalledBrowser[]);
    void installedBrowsersRequest.then((found) => {
      installedBrowsers = found;
      if (!cancelled) setTick((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [browserName]);
  if (!browserName || !installedBrowsers) return null;
  const needle = browserName.toLowerCase();
  const match = installedBrowsers.find((browser) =>
    browser.id === needle || browser.label.toLowerCase().includes(needle),
  );
  return match?.iconDataUrl ?? null;
}

function adeIconUrl(): string {
  const path = "welcome/ade-icon.webp";
  if (typeof window !== "undefined" && /^https?:$/.test(window.location.protocol)) return `/${path}`;
  return `./${path}`;
}

/** The surface glyphs drawn as one icon; `user` and `apple` draw their own (`SurfaceGlyph`). */
const SURFACE_GLYPH: Record<Exclude<ComputerUseSurfaceGlyph, "user" | "apple">, Icon> = {
  screen: Monitor,
  app: AppWindow,
  globe: Globe,
  proof: Seal,
};

function fallbackGlyph(summary: ComputerUseActionSummary): Icon {
  switch (summary.surface) {
    case "lane_screen":
    case "app_control":
      return AppWindow;
    case "ade_browser": return Globe;
    case "user_browser": return Browser;
    case "apple_device": return DeviceMobile;
    case "proof": return Seal;
  }
}

function ComputerUseAppIcon({
  summary,
  size,
  inline = false,
}: {
  summary: ComputerUseActionSummary;
  size: 14 | 18;
  /** Inside a line of text rather than in the row's icon column. */
  inline?: boolean;
}) {
  const isUserBrowser = summary.surface === "user_browser";
  const browserIcon = useInstalledBrowserIcon(isUserBrowser ? summary.browserName : null);
  const lookupName = isUserBrowser || summary.surface === "ade_browser" || summary.surface === "proof"
    ? null
    : summary.appName;
  const appIcon = useAppIcon(lookupName);
  const src = isUserBrowser
    ? browserIcon
    : summary.surface === "ade_browser" || summary.surface === "proof"
      ? adeIconUrl()
      : appIcon;
  const boxClass = size === 18 ? "size-[18px] rounded-[4px]" : "size-[14px] rounded-[3px]";
  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        width={size}
        height={size}
        draggable={false}
        data-testid="computer-use-app-icon"
        className={cn("shrink-0 object-contain", inline ? "inline-block" : "justify-self-center", boxClass)}
      />
    );
  }
  const Glyph = fallbackGlyph(summary);
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center text-muted-fg", !inline && "justify-self-center", boxClass)}>
      <Glyph size={size === 18 ? 15 : 12} weight="regular" />
    </span>
  );
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

// [action icon] [the line] [status]. The line is only as wide as its words, so
// the status sits right after it, not at the far edge of a wide column. The
// image-view line (`CodexImageViewLine`) uses the same grid, so it sits in the
// run of actions around it.
export const ACTION_ROW_GRID = "grid grid-cols-[18px_minmax(0,max-content)_auto] items-center justify-start gap-x-2.5";
// Background work: every line is one small size, newest or not.
export const ACTION_ROW_TEXT = "text-[length:calc(var(--chat-font-size)*11/14)]";
const ACTION_LINE = `inline-flex min-w-0 items-center ${ACTION_ROW_TEXT}`;

/**
 * A line that opens pictures under it. The whole line is the button; a small
 * caret after its words turns when it opens.
 */
export function ActionLineToggle({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        "group/line inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-left",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/40",
        ACTION_ROW_TEXT,
      )}
    >
      {children}
      <CaretRight
        size={9}
        weight="bold"
        aria-hidden
        className={cn(
          "ml-1.5 shrink-0 text-muted-fg/60 transition-transform group-hover/line:text-fg/80",
          open && "rotate-90 text-fg/70",
        )}
      />
    </button>
  );
}

/** The icon for what the action did: a click, typing, a look, a proof. */
function actionGlyph(summary: ComputerUseActionSummary): Icon {
  if (summary.proof) return Seal;
  switch (summary.verb) {
    case "click":
    case "double-click":
    case "right-click":
    case "hover":
      return CursorClick;
    case "tap":
    case "long-press":
      return HandTap;
    case "type":
    case "fill":
    case "clear":
      return TextT;
    case "press":
    case "key":
      return Keyboard;
    case "scroll":
    case "swipe":
      return ArrowsDownUp;
    case "drag":
      return HandGrabbing;
    case "observe":
    case "snapshot":
      return Eye;
    case "screenshot":
      return Camera;
    case "attach":
      return Plugs;
    case "wait":
    case "wait-for-element":
      return Hourglass;
    case "open":
    case "launch":
    case "relaunch":
      return AppWindow;
    case "open-url":
    case "navigate":
    case "new-tab":
    case "back":
    case "forward":
    case "reload":
      return Globe;
    default:
      return CursorClick;
  }
}

/** The surface's icon: the device for an Apple row, else the surface's glyph. */
function SurfaceGlyph({ summary, glyph, size }: { summary: ComputerUseActionSummary; glyph: ComputerUseSurfaceGlyph; size: number }) {
  if (glyph === "apple") {
    return (
      <span aria-hidden className="inline-flex items-center gap-px">
        <AppleLogo size={size} weight="fill" />
        <DeviceMobile size={size} />
      </span>
    );
  }
  if (glyph === "user") {
    return <ComputerUseAppIcon summary={summary} size={14} inline />;
  }
  const Glyph = SURFACE_GLYPH[glyph];
  return <Glyph size={size} aria-hidden />;
}

/**
 * The action as one line: "Clicked “Save” in [icon] TextEdit", "Pressed
 * “Escape” on [icon] Mac Desktop". A running action shimmers as one line: a
 * single sweep crosses every word. Its icons get their own colour, so the
 * text-clipped sweep never hides them.
 */
function ActionLine({ summary, emphasize }: { summary: ComputerUseActionSummary; emphasize: boolean }) {
  const parts = computerUseActionParts(summary);
  const running = summary.outcome === "running";
  const failed = summary.outcome === "failed";
  const words = (text: string, className?: string) => (
    <span className={running ? undefined : className}>{text}</span>
  );
  const iconSize = 12;
  // The newest line stands out by colour and its status icon, never by size.
  return (
    <span
      className={cn(
        "min-w-0 truncate leading-[1.5]",
        ACTION_ROW_TEXT,
        running && "ade-thinking-shimmer [&_svg]:text-muted-fg",
        emphasize ? "text-fg/80" : "text-muted-fg",
      )}
      title={computerUseActionText(summary)}
    >
      {words(parts.lead, cn(failed && emphasize && "text-error"))}
      {parts.target ? (
        <>
          {" "}
          {/* "Opened [icon] TextEdit": an app named as the object gets its icon too. */}
          {parts.target === summary.appName && summary.surface !== "user_browser" ? (
            <span className="mr-1 inline-flex items-center align-[-2px]"><ComputerUseAppIcon summary={summary} size={14} inline /></span>
          ) : null}
          {words(
            parts.targetQuoted ? `“${parts.target}”` : parts.target,
            cn(emphasize && (failed ? "text-error" : "text-fg/90")),
          )}
        </>
      ) : null}
      {parts.place ? (
        <>
          {" "}
          {words(parts.place.preposition, emphasize ? "text-muted-fg" : undefined)}{" "}
          <span className="inline-flex items-baseline gap-1 align-baseline">
            {parts.place.kind === "app" ? (
              <span className="self-center"><ComputerUseAppIcon summary={summary} size={14} inline /></span>
            ) : parts.place.kind === "site" ? (
              <Globe size={iconSize} aria-hidden className="self-center text-muted-fg" />
            ) : null}
            {words(parts.place.label, emphasize ? "text-fg/90" : undefined)}
          </span>
        </>
      ) : null}
      {parts.surface ? (
        <>
          {" "}
          {words(parts.surface.preposition, emphasize ? "text-muted-fg" : undefined)}{" "}
          <span
            className={cn(
              "inline-flex items-baseline gap-1 align-baseline",
              parts.surface.warning ? "text-warning" : emphasize ? "text-muted-fg" : undefined,
            )}
          >
            <span className="self-center"><SurfaceGlyph summary={summary} glyph={parts.surface.glyph} size={iconSize} /></span>
            {words(parts.surface.label, parts.surface.warning ? "text-warning" : undefined)}
          </span>
        </>
      ) : null}
      {parts.suffix ? <> {words(parts.suffix, "text-muted-fg")}</> : null}
      {running ? words("…") : null}
    </span>
  );
}

/**
 * The mark after a line. Success needs none: the words already say what
 * happened, and a mark on every line hid the ones that matter. A warning and a
 * failure get the same mark on every line, newest or not.
 */
const OUTCOME_STATUS: Record<ComputerUseActionOutcome, { label: string; icon: Icon | null; iconClass: string }> = {
  running: { label: "Running", icon: null, iconClass: "" },
  observed: { label: "Done", icon: null, iconClass: "" },
  not_checked: { label: "Done", icon: null, iconClass: "" },
  unconfirmed: { label: "No change seen", icon: Warning, iconClass: "text-warning" },
  failed: { label: "Failed", icon: XCircle, iconClass: "text-error" },
};

export function StatusIcon({ outcome }: { outcome: ComputerUseActionOutcome }) {
  const status = OUTCOME_STATUS[outcome];
  const StatusGlyph = status.icon;
  if (!StatusGlyph) return <span aria-hidden className="size-[12px]" />;
  return <StatusGlyph size={12} weight="regular" className={status.iconClass} aria-label={status.label} />;
}

function ActionGlyph({ summary, emphasize }: { summary: ComputerUseActionSummary; emphasize: boolean }) {
  const Glyph = actionGlyph(summary);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center justify-self-center",
        emphasize ? "text-fg/75" : "text-muted-fg",
      )}
    >
      <Glyph size={13} weight="regular" />
    </span>
  );
}

/** "×3": how many identical actions one line stands for. */
function RepeatCount({ count }: { count: number }) {
  if (count < 2) return null;
  return (
    <span className="ml-1.5 shrink-0 tabular-nums text-muted-fg" aria-label={`${count} times`}>
      ×{count}
    </span>
  );
}

/**
 * What a line opens under it, once opened: the proof it filed, or the images
 * the agent opened that its actions wrote. They start at the row's left edge,
 * where the thread's text starts, not under the words.
 */
function LinePictures({ pictures }: { pictures: ReturnType<typeof computerUseLinePictures> }) {
  return (
    <span className="col-start-1 col-end-4 mb-1 mt-1.5 flex min-w-0 gap-1.5" data-testid="computer-use-line-pictures">
      {pictures.proofIds.length
        ? pictures.proofIds.map((id) => <ProofActionThumbnail key={id} artifactId={id} height={PROOF_THUMBNAIL_HEIGHT} />)
        : <ViewedImageStrip views={pictures.views} height={PROOF_THUMBNAIL_HEIGHT} />}
    </span>
  );
}

/** The note under a line: why it failed, or (newest line only) why ADE is unsure. */
function OutcomeNote({ summary, warnings }: { summary: ComputerUseActionSummary; warnings: boolean }) {
  const note = computerUseOutcomeNote(summary);
  if (!note || (note.tone === "warning" && !warnings)) return null;
  return (
    <span
      className={cn(
        "col-start-2 col-end-4 mt-0.5 min-w-0 text-[length:calc(var(--chat-font-size)*10.5/14)] leading-[1.45]",
        note.tone === "danger" ? "text-error" : "text-warning",
      )}
      data-testid="computer-use-action-note"
    >
      {note.text}
    </span>
  );
}

/**
 * One line of a run. The newest action of the turn is `full`: brighter words
 * and the warning note too. A line with pictures opens them under it.
 */
function ActionRow({ line, full }: { line: ComputerUseRunLine<ChatWorkLogEntry>; full: boolean }) {
  const { summary, count } = line;
  const [open, setOpen] = useState(false);
  const pictures = useMemo(() => computerUseLinePictures(line), [line]);
  const hasPictures = pictures.proofIds.length > 0 || pictures.views.length > 0;
  const words = (
    <>
      <ActionLine summary={summary} emphasize={full} />
      <RepeatCount count={count} />
    </>
  );
  return (
    <div
      className={cn(ACTION_ROW_GRID, "py-0.5")}
      data-testid={full ? "computer-use-action-full" : "computer-use-action-compact"}
      data-outcome={summary.outcome}
    >
      <ActionGlyph summary={summary} emphasize={full} />
      {hasPictures
        ? <ActionLineToggle open={open} onToggle={() => setOpen((value) => !value)}>{words}</ActionLineToggle>
        : <span className={ACTION_LINE}>{words}</span>}
      <StatusIcon outcome={summary.outcome} />
      <OutcomeNote summary={summary} warnings={full} />
      {open && hasPictures ? <LinePictures pictures={pictures} /> : null}
    </div>
  );
}

/**
 * One run of computer-use actions: the computer-use entries of one
 * work-log group, in order.
 */
export const ChatComputerUseActionRun = React.memo(function ChatComputerUseActionRun({
  entries,
  compactAll = false,
}: {
  entries: readonly ChatWorkLogEntry[];
  /** Not the turn's newest run: its newest action is compact too. */
  compactAll?: boolean;
}) {
  const layout = useMemo(() => layoutComputerUseRun(collectComputerUseActions(entries)), [entries]);
  if (!layout.latest) return null;
  return (
    <div
      className="w-full min-w-0 max-w-[var(--chat-content-width,52rem)] font-sans"
      data-testid="computer-use-actions"
    >
      {layout.earlier.map((line) => <ActionRow key={line.action.id} line={line} full={false} />)}
      <ActionRow key={layout.latest.action.id} line={layout.latest} full={!compactAll} />
    </div>
  );
});

/** A compact icon for the tools list, where a computer-use command is one row. */
export function ComputerUseInlineIcon({ summary }: { summary: ComputerUseActionSummary }) {
  return <ComputerUseAppIcon summary={summary} size={14} />;
}
