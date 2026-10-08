/**
 * Computer-use action rows in the chat thread.
 *
 * An agent drives a screen through its shell tool (`ade screen click …`,
 * `ade browser fill …`). Those calls used to show only in the tools list as
 * shell commands. Here each one becomes a sentence naming what it acted on —
 * "Clicked “Checkout” on localhost:5173", "Pressed “Escape” in ADE" — in a
 * quiet run of rows on one grid: [action icon] [text] [status]. The latest
 * action of a run is drawn in full (bigger icon, failure reason); earlier ones
 * are one muted line with a status dot. Identical actions in a row merge into
 * one line with a count ("Looked at ADE ×3"). A filed proof shows its picture
 * small under its line; a click enlarges it in place. No row opens: the line
 * is all there is to say.
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
  CheckCircle,
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
  computerUseShownProofIds,
  layoutComputerUseRun,
  type ComputerUseSurfaceGlyph,
} from "../../../shared/computerUseActionPresentation";
import type { ComputerUseActionOutcome, ComputerUseActionSummary } from "../../../shared/computerUseActionSummary";
import type { InstalledBrowser } from "../../../shared/browserTargets";
import { cn } from "../ui/cn";
import { collectComputerUseActions, PROOF_THUMBNAIL_HEIGHT } from "./chatComputerUseRows";
import { ProofActionThumbnail } from "./ChatProofCitation";
import type { ChatWorkLogEntry } from "./chatTranscriptRows";

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
  if (typeof getAppIcon !== "function") return null;
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
    if (typeof detector !== "function") return;
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

/** The "using" glyphs drawn as one icon; `user` and `apple` draw their own (`UsingGlyph`). */
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
// the status sits right after it, not at the far edge of a wide column.
const ROW_GRID = "grid grid-cols-[18px_minmax(0,max-content)_auto] items-center justify-start gap-x-2.5";

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
function UsingGlyph({ summary, glyph, size }: { summary: ComputerUseActionSummary; glyph: ComputerUseSurfaceGlyph; size: number }) {
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
 * “Escape” on [icon] Mac Desktop". A running action shimmers word by word; its
 * icons stay solid, so the sweep never hides them.
 */
function ActionLine({ summary, emphasize }: { summary: ComputerUseActionSummary; emphasize: boolean }) {
  const parts = computerUseActionParts(summary);
  const running = summary.outcome === "running";
  const failed = summary.outcome === "failed";
  const words = (text: string, className?: string) => (
    <span className={cn(running ? "ade-thinking-shimmer" : className)}>{text}</span>
  );
  const iconSize = emphasize ? 13 : 12;
  return (
    <span
      className={cn(
        "min-w-0 truncate",
        emphasize
          ? "text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.45] text-fg/90"
          : "text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.5] text-muted-fg",
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
            cn(emphasize && "font-medium", emphasize && (failed ? "text-error" : "text-fg")),
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
      {parts.using ? (
        <>
          {" "}
          {words(parts.using.preposition, emphasize ? "text-muted-fg" : undefined)}{" "}
          <span
            className={cn(
              "inline-flex items-baseline gap-1 align-baseline",
              parts.using.warning ? "text-warning" : emphasize ? "text-muted-fg" : undefined,
            )}
          >
            <span className="self-center"><UsingGlyph summary={summary} glyph={parts.using.glyph} size={iconSize} /></span>
            {words(parts.using.label, parts.using.warning ? "text-warning" : undefined)}
          </span>
        </>
      ) : null}
      {parts.suffix ? <> {words(parts.suffix, "text-muted-fg")}</> : null}
      {running ? words("…") : null}
    </span>
  );
}

/** How each outcome shows: the full row's status icon, and the compact row's dot. */
const OUTCOME_STATUS: Record<ComputerUseActionOutcome, {
  label: string;
  icon: Icon | null;
  iconClass: string;
  dot: "warn" | "crit" | undefined;
}> = {
  running: { label: "Running", icon: null, iconClass: "", dot: undefined },
  observed: { label: "Done", icon: CheckCircle, iconClass: "text-success", dot: undefined },
  not_checked: { label: "Done", icon: CheckCircle, iconClass: "text-success", dot: undefined },
  unconfirmed: { label: "No change seen", icon: Warning, iconClass: "text-warning", dot: "warn" },
  failed: { label: "Failed", icon: XCircle, iconClass: "text-error", dot: "crit" },
};

function StatusIcon({ summary }: { summary: ComputerUseActionSummary }) {
  const status = OUTCOME_STATUS[summary.outcome];
  const StatusGlyph = status.icon;
  if (!StatusGlyph) return <span aria-hidden className="size-[14px]" />;
  return <StatusGlyph size={14} weight="regular" className={status.iconClass} aria-label={status.label} />;
}

function Dot({ outcome }: { outcome: ComputerUseActionOutcome }) {
  const status = OUTCOME_STATUS[outcome];
  return <span className="kit-dot" data-state={status.dot} aria-label={status.label} />;
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
      <Glyph size={emphasize ? 15 : 13} weight="regular" />
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
 * The pictures a filed-proof line filed, small, under the line. They start at
 * the row's left edge, where the thread's text starts, not under the words.
 */
function ProofThumbnails({ summary }: { summary: ComputerUseActionSummary }) {
  const ids = computerUseShownProofIds(summary);
  if (!ids.length) return null;
  return (
    <span className="col-start-1 col-end-4 mb-1 mt-1 flex min-w-0 gap-1.5" data-testid="computer-use-proof-thumbnails">
      {ids.map((id) => <ProofActionThumbnail key={id} artifactId={id} height={PROOF_THUMBNAIL_HEIGHT} />)}
    </span>
  );
}

/** The newest action: the full line, its status, and what went wrong. */
function FullActionRow({ summary, count }: { summary: ComputerUseActionSummary; count: number }) {
  const note = computerUseOutcomeNote(summary);
  return (
    <div
      className={cn(ROW_GRID, "py-1")}
      data-testid="computer-use-action-full"
      data-outcome={summary.outcome}
    >
      <ActionGlyph summary={summary} emphasize />
      <span className="inline-flex min-w-0 items-center text-[length:calc(var(--chat-font-size)*12/14)]">
        <ActionLine summary={summary} emphasize />
        <RepeatCount count={count} />
      </span>
      <StatusIcon summary={summary} />
      {note ? (
        <span
          className={cn(
            "col-start-2 col-end-4 mt-0.5 min-w-0 text-[length:calc(var(--chat-font-size)*11.5/14)] leading-[1.45]",
            note.tone === "danger" ? "text-error" : "text-warning",
          )}
          data-testid="computer-use-action-note"
        >
          {note.text}
        </span>
      ) : null}
      <ProofThumbnails summary={summary} />
    </div>
  );
}

function CompactActionRow({ summary, count }: { summary: ComputerUseActionSummary; count: number }) {
  return (
    <div className={cn(ROW_GRID, "py-0.5")} data-testid="computer-use-action-compact">
      <ActionGlyph summary={summary} emphasize={false} />
      <span className="inline-flex min-w-0 items-center text-[length:calc(var(--chat-font-size)*12/14)]">
        <ActionLine summary={summary} emphasize={false} />
        <RepeatCount count={count} />
      </span>
      <Dot outcome={summary.outcome} />
      <ProofThumbnails summary={summary} />
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
      {layout.earlier.map((line) => (
        <CompactActionRow key={line.action.id} summary={line.summary} count={line.count} />
      ))}
      {compactAll
        ? <CompactActionRow summary={layout.latest.summary} count={layout.latest.count} />
        : <FullActionRow summary={layout.latest.summary} count={layout.latest.count} />}
    </div>
  );
});

/** A compact icon for the tools list, where a computer-use command is one row. */
export function ComputerUseInlineIcon({ summary }: { summary: ComputerUseActionSummary }) {
  return <ComputerUseAppIcon summary={summary} size={14} />;
}
