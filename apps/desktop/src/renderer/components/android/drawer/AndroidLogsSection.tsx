import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChatCircleText, Copy, Pause, Play, Trash } from "@phosphor-icons/react";
import type { AndroidLogLevel, AndroidLogLine } from "../../../../shared/types/androidEmulator";
import { cn } from "../../ui/cn";
import {
  DRAWER_BUTTON,
  DRAWER_ICON_BUTTON,
  DRAWER_INPUT,
  DRAWER_PRIMARY_BUTTON,
  DrawerMenu,
  DrawerSegmented,
  type DrawerMenuOption,
} from "../../ui/drawerPrimitives";
import { logRendererDebugEvent } from "../../../lib/debugLog";
import { describeAndroidError } from "../androidDeviceState";
import { androidTextDraft, copyAndroidText } from "../androidTextDraft";
import type { AndroidDrawerContext } from "./androidDrawerState";

/*
 * The **Logs** group (plan §5, P2): logcat for the lane's app only. The same
 * bounded read as `ade android log` (`readLog`), again every
 * `ANDROID_LOG_POLL_MS` with the last line's cursor, so each read carries only
 * new lines. It reads only while the group is open and the window is in front.
 *
 * "The lane's app" is the newest package ADE installed for the lane, else the
 * app in front. "Whole device" is there for the rest.
 */

const ANDROID_LOG_POLL_MS = 2_000;
/** The lines the card keeps; older ones drop off the top. */
const ANDROID_LOG_KEEP_LINES = 500;
/** The first read's lines: the recent past, not the whole buffer. */
const ANDROID_LOG_FIRST_LINES = 200;
/** The newest lines "Send to chat" writes into the draft. */
const ANDROID_LOG_DRAFT_LINES = 80;
const WHOLE_DEVICE = "*";

const LEVELS: readonly { value: AndroidLogLevel; label: string }[] = [
  { value: "verbose", label: "All" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
];

const LEVEL_CLASS: Record<AndroidLogLine["level"], string> = {
  V: "text-muted-fg/70",
  D: "text-muted-fg",
  I: "text-fg/80",
  W: "text-[var(--color-warning)]",
  E: "text-[var(--color-error)]",
  F: "text-[var(--color-error)]",
  S: "text-muted-fg/70",
};

function lineTime(time: string): string {
  const date = new Date(Number(time) * 1000);
  if (Number.isNaN(date.getTime())) return time;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** One line as logcat would print it, for Copy and "Send to chat". */
function lineText(line: AndroidLogLine): string {
  return `${lineTime(line.time)} ${line.pid} ${line.level} ${line.tag}: ${line.message}`;
}

export function AndroidLogsSection({ ctx }: { ctx: AndroidDrawerContext }) {
  const { laneId, pinRef, visible, lanePackages, onInsertDraft } = ctx;
  const lanePackage = lanePackages.at(-1) ?? null;
  const [foreground, setForeground] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [level, setLevel] = useState<AndroidLogLevel>("verbose");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<AndroidLogLine[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  // The app in front, once, for a lane that has no app of its own yet.
  useEffect(() => {
    if (!visible || lanePackage) return undefined;
    let cancelled = false;
    window.ade.androidEmulator.getDeviceSettings({ laneId, fields: "foreground" }, pinRef.current)
      .then((answer) => { if (!cancelled) setForeground(answer.foregroundPackage); })
      .catch((cause: unknown) => {
        // No answer: the menu offers the whole device.
        logRendererDebugEvent("android.logs_foreground_failed", { error: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => { cancelled = true; };
  }, [laneId, lanePackage, pinRef, visible]);

  const target = picked ?? lanePackage ?? foreground ?? WHOLE_DEVICE;
  const packageName = target === WHOLE_DEVICE ? null : target;

  const options = useMemo(() => {
    const list: DrawerMenuOption<string>[] = lanePackages.map((name) => ({ value: name, label: name, group: "This lane's apps" }));
    if (foreground && !lanePackages.includes(foreground)) list.push({ value: foreground, label: foreground, group: "In front" });
    if (picked && picked !== WHOLE_DEVICE && !list.some((option) => option.value === picked)) list.push({ value: picked, label: picked });
    list.push({ value: WHOLE_DEVICE, label: "Whole device", group: "Other" });
    return list;
  }, [foreground, lanePackages, picked]);

  // A new app or level starts the card over from the recent past.
  useEffect(() => {
    cursorRef.current = null;
    stickRef.current = true;
    setLines([]);
    setReadError(null);
  }, [laneId, level, packageName]);

  useEffect(() => {
    if (!visible || paused) return undefined;
    let cancelled = false;
    let running = false;
    const read = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        const since = cursorRef.current;
        const answer = await window.ade.androidEmulator.readLog({
          laneId,
          packageName,
          level,
          since,
          lines: since ? ANDROID_LOG_KEEP_LINES : ANDROID_LOG_FIRST_LINES,
        }, pinRef.current);
        if (cancelled) return;
        cursorRef.current = answer.cursor ?? since;
        setReadError(null);
        if (answer.lines.length > 0) {
          setLines((current) => [...current, ...answer.lines].slice(-ANDROID_LOG_KEEP_LINES));
        }
      } catch (cause: unknown) {
        if (!cancelled) setReadError(describeAndroidError(cause).sentence);
      } finally {
        running = false;
      }
    };
    void read();
    const timer = window.setInterval(() => { void read(); }, ANDROID_LOG_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [laneId, level, packageName, paused, pinRef, visible]);

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => (needle ? lines.filter((line) => line.tag.toLowerCase().includes(needle) || line.message.toLowerCase().includes(needle)) : lines),
    [lines, needle],
  );

  // New lines keep the list at the bottom, unless the person scrolled up to read.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && stickRef.current) list.scrollTop = list.scrollHeight;
  }, [shown]);

  const sendToChat = () => {
    if (!onInsertDraft || shown.length === 0) return;
    const text = shown.slice(-ANDROID_LOG_DRAFT_LINES).map(lineText).join("\n");
    onInsertDraft(androidTextDraft(`Logcat for ${packageName ?? "the whole device"} on the lane's Android emulator:`, text));
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-android-logs="">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <DrawerMenu
          ariaLabel="Whose log"
          value={target}
          placeholder="Pick an app"
          options={options}
          disabled={false}
          onChange={setPicked}
          className="max-w-[13rem]"
        />
        <DrawerSegmented ariaLabel="Lowest level" value={level} options={LEVELS} disabled={false} onChange={setLevel} />
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          type="search"
          value={query}
          placeholder="Filter by tag or text"
          aria-label="Filter the log"
          className={DRAWER_INPUT}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className={DRAWER_ICON_BUTTON}
          aria-label={paused ? "Resume the log" : "Pause the log"}
          title={paused ? "Resume" : "Pause"}
          aria-pressed={paused}
          onClick={() => setPaused((value) => !value)}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        <button
          type="button"
          className={DRAWER_ICON_BUTTON}
          aria-label="Clear the log"
          title="Clear"
          disabled={lines.length === 0}
          onClick={() => setLines([])}
        >
          <Trash size={13} />
        </button>
      </div>
      <div
        ref={listRef}
        role="log"
        aria-live="off"
        className="@container max-h-72 min-h-24 overflow-auto rounded-[6px] bg-fg/[0.04] px-1.5 py-1 font-mono text-[10.5px] leading-[1.45] select-text"
        onScroll={(event) => {
          const list = event.currentTarget;
          stickRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
        }}
      >
        {shown.length === 0 ? (
          <p className="m-0 py-2 text-center font-sans text-[11px] text-muted-fg">
            {readError ?? (lines.length > 0 ? "No line matches the filter." : paused ? "Paused." : "No lines yet.")}
          </p>
        ) : shown.map((line, index) => (
          <div
            key={`${line.time}:${line.pid}:${index}`}
            title={`${lineTime(line.time)} · pid ${line.pid}`}
            className="flex min-w-0 gap-1.5 whitespace-pre-wrap break-words"
          >
            {/* The time takes a column only where the drawer is wide; it is always on the row's tooltip. */}
            <span className="hidden shrink-0 text-muted-fg/60 @[26rem]:inline">{lineTime(line.time)}</span>
            <span className={cn("shrink-0 font-semibold", LEVEL_CLASS[line.level])}>{line.level}</span>
            <span className={cn("min-w-0", LEVEL_CLASS[line.level])}>
              <span className="text-fg/60">{line.tag}:</span> {line.message}
            </span>
          </div>
        ))}
      </div>
      {readError && shown.length > 0 ? <p className="m-0 text-[11px] text-muted-fg">{readError}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {onInsertDraft ? (
          <button type="button" className={DRAWER_PRIMARY_BUTTON} disabled={shown.length === 0} onClick={sendToChat}>
            <ChatCircleText size={13} />
            Send to chat
          </button>
        ) : null}
        <button
          type="button"
          className={DRAWER_BUTTON}
          disabled={shown.length === 0}
          onClick={() => copyAndroidText(shown.map(lineText).join("\n"))}
        >
          <Copy size={13} />
          Copy
        </button>
      </div>
    </div>
  );
}
