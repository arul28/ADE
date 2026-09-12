/**
 * The event log behind the iOS simulator drawer.
 *
 * The drawer shows one list with two kinds of rows. Device rows come from the
 * app's own `os_log` output on the simulator. ADE rows come from `record` and
 * say what ADE did. One list keeps the order visible, so a person sees that the
 * dark-mode switch happened between two app log lines. Two side-by-side lists
 * hide that order, because nothing ties the clocks together.
 *
 * This module starts no process itself. `deps.spawnLogStream` owns the child
 * process, so a test drives the full lifecycle with no simulator and no timers.
 * The caller runs this command:
 *
 *     xcrun simctl spawn <udid> log stream --style compact --level info \
 *       --predicate '<predicate>'
 *
 * The command writes one record per line and never exits on its own. An exit is
 * therefore always a failure, and rule 5 records it in `lastError`.
 */
import type {
  IosSimulatorEventLogPage,
  IosSimulatorLogRow,
} from "../../../shared/types/iosSimulator";

/** Rows kept in the ring when the caller sets no capacity. */
const DEFAULT_CAPACITY = 500;

/** Rows returned by `read` when the caller sets no limit. */
const DEFAULT_READ_LIMIT = 200;

/**
 * Upper bound on one `read`.
 *
 * The page crosses an IPC boundary and lands in a React list. A caller that
 * asks for the whole ring on every poll stalls the renderer, so the cap is here
 * and not at the call site.
 */
const MAX_READ_LIMIT = 1_000;

/**
 * The shape of one `--style compact` record.
 *
 * Read the groups in order: an optional date, the time, an optional two-letter
 * type code, the process name, `[pid:tid]`, an optional `[subsystem:category]`,
 * then the rest of the line as the message. The date is optional because the
 * first record of a stream sometimes carries only a time. The type code is
 * optional because a record at the default level prints no code.
 *
 * The process group excludes `[` and `]`, so the bracket that opens `[pid:tid]`
 * always ends the process name.
 */
const COMPACT_LINE =
  /^(?:\d{4}-\d{2}-\d{2}\s+)?\d{1,2}:\d{2}:\d{2}\.\d+\s+(?:([A-Za-z]{1,2})\s+)?([^\s[\]]+)\[\d+(?::[0-9a-fA-Fx]+)?\]\s*(?:\[([^\]:]*):([^\]]*)\]\s*)?(.*)$/;

/**
 * Characters that end the quoted string in a `--predicate` argument.
 *
 * A bundle id reaches this module from project settings and from the renderer.
 * A double quote closes the literal early and a backslash escapes the quote, so
 * both let a caller append a new predicate clause. Reject the input instead of
 * escaping it, because a bundle id never contains either character.
 */
const PREDICATE_UNSAFE = /["\\]/;

/**
 * Maps a compact type code to a row level.
 *
 * Apple prints more codes than it documents, and the set grows between OS
 * releases. An unknown code returns "default", so a new code shows the message
 * at a plain level instead of losing the row.
 */
function levelForTypeCode(code: string | undefined): IosSimulatorLogRow["level"] {
  switch ((code ?? "").trim().toLowerCase()) {
    case "d":
    case "db":
    case "df":
    case "dg":
      return "debug";
    case "i":
    case "in":
      return "info";
    case "e":
    case "er":
      return "error";
    case "f":
    case "fa":
      return "fault";
    default:
      return "default";
  }
}

/** Returns the trimmed text, or null when nothing is left. */
function textOrNull(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parses one `log stream --style compact` line. Never returns null.
 *
 * A shape this parser does not know is still information. An unmatched line
 * keeps the whole text as `message`, takes the level "default", and leaves
 * `process`, `subsystem`, and `category` null. A dropped line hides the one
 * message the person needs, and a crash report is the line most likely to
 * break the expected shape.
 *
 * `at` comes from the caller and not from the line. The device timestamp has no
 * time zone and follows the simulator clock, so it cannot order device rows
 * against ADE rows. The caller clock stamps both kinds of row, so the ids and
 * the timestamps agree.
 */
export function parseCompactLogLine(
  line: string,
  id: number,
  at: string,
): IosSimulatorLogRow {
  const match = COMPACT_LINE.exec(line);
  if (!match) {
    return {
      id,
      at,
      source: "device",
      level: "default",
      process: null,
      subsystem: null,
      category: null,
      message: line,
      command: null,
    };
  }
  const [, typeCode, processName, subsystem, category, message] = match;
  return {
    id,
    at,
    source: "device",
    level: levelForTypeCode(typeCode),
    process: textOrNull(processName),
    subsystem: textOrNull(subsystem),
    category: textOrNull(category),
    message: (message ?? "").trim(),
    command: null,
  };
}

/**
 * Builds the `--predicate` value for an app, or null when there is nothing to
 * filter by.
 *
 * An explicit predicate wins and returns unchanged. The caller who writes a
 * predicate by hand knows more about the app than this function does.
 *
 * A bundle id produces `subsystem BEGINSWITH "<bundleId>"` and nothing else.
 * The obvious filter also matches `process == "<name>"`, but a bundle id does
 * not carry the process name: the executable name comes from the build
 * settings and is frequently not the last component of the bundle id. A guess
 * there would drop real rows. IMPORTANT: the app must log with its bundle id as
 * the `os_log` subsystem, or this filter catches nothing. `BEGINSWITH` rather
 * than `==` so that a subsystem such as `com.acme.app.networking` still
 * matches.
 *
 * There is deliberately no raw-predicate escape hatch. `log stream` reads the
 * WHOLE device, so an arbitrary predicate returns every other app's rows and
 * the system's besides — and nothing in the product ever asked for that. An
 * agent that genuinely needs a device-wide log can run `simctl spawn` itself.
 *
 * @throws Error when the bundle id contains a double quote or a backslash.
 */
export function buildLogPredicate(args: {
  bundleId?: string | null;
}): string | null {
  const bundleId = (args.bundleId ?? "").trim();
  if (bundleId.length === 0) {
    return null;
  }
  if (PREDICATE_UNSAFE.test(bundleId)) {
    throw new Error(
      `Refusing to build a log predicate from bundle id ${JSON.stringify(bundleId)}: a quote or a backslash can add predicate clauses.`,
    );
  }
  return `subsystem BEGINSWITH "${bundleId}"`;
}

export type IosEventLogDeps = {
  /** Spawns the log stream. Mirrors `child_process.spawn`'s shape, injected for tests. */
  spawnLogStream: (deviceUdid: string, predicate: string | null) => IosEventLogProcess;
  now?: () => Date;
  /** Defaults to 500. */
  capacity?: number;
  logger?: { debug: (event: string, data?: Record<string, unknown>) => void };
};

export type IosEventLogProcess = {
  onLine: (handler: (line: string) => void) => void;
  onError: (handler: (error: Error) => void) => void;
  onExit: (handler: (code: number | null) => void) => void;
  kill: () => void;
};

/**
 * One run of the log stream.
 *
 * `live` is the single gate on every handler. The process interface has no
 * unsubscribe call, so a handler that outlives its run must test this flag.
 * Rule 4 depends on it: a line that arrives after `stop` finds `live` false and
 * goes nowhere.
 */
type EventLogSession = {
  deviceUdid: string;
  /**
   * The predicate this stream runs with.
   *
   * Kept so a second `start` can tell "the same log" from "the same device,
   * another app". Without it a bundle-id change was answered with a no-op and
   * the stream kept filtering for the app the caller had moved off.
   */
  predicate: string | null;
  process: IosEventLogProcess;
  live: boolean;
};

/**
 * Clamps a caller limit into the allowed range.
 *
 * A missing or non-numeric limit takes the default. Any real number clamps, so
 * a zero or a negative number returns one row instead of an empty page that
 * looks like "no new rows".
 */
function clampReadLimit(limit: number | null | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_READ_LIMIT;
  }
  return Math.min(MAX_READ_LIMIT, Math.max(1, Math.floor(limit)));
}

export function createIosEventLog(deps: IosEventLogDeps): {
  start(args: { deviceUdid: string; bundleId?: string | null }): void;
  stop(): void;
  isRunning(): boolean;
  activeDeviceUdid(): string | null;
  /** Adds a row describing something ADE did. */
  record(row: {
    message: string;
    command?: string | null;
    level?: IosSimulatorLogRow["level"];
  }): IosSimulatorLogRow;
  read(args: { sinceId?: number | null; limit?: number | null }): IosSimulatorEventLogPage;
  /**
   * The newest rows, with no page and no side effect.
   *
   * For a reader that is not the one showing the gap. A proof capture wants
   * the rows and nothing else, and taking them through `read` consumed the
   * dropped-row counter the drawer's poll needs, so the drawer's next page
   * reported no gap for rows it never saw.
   */
  snapshotRows(limit?: number | null): IosSimulatorLogRow[];
  dispose(): void;
} {
  const capacity = Math.max(1, Math.floor(deps.capacity ?? DEFAULT_CAPACITY));
  const clock = deps.now ?? (() => new Date());
  const logger = deps.logger;

  const rows: IosSimulatorLogRow[] = [];
  let session: EventLogSession | null = null;
  let deviceUdid: string | null = null;
  /**
   * The predicate the buffered rows came from.
   *
   * Held next to `deviceUdid`, not inside `session`, because `stop` clears the
   * session and keeps the rows. Without it a stop followed by a start on
   * another app read as "same device, nothing changed", and the first app's
   * rows stayed in the ring under the second app's header.
   */
  let bufferPredicate: string | null = null;
  let lastError: string | null = null;
  /** Highest id ever handed out. It never resets, so `sinceId` never repeats. */
  let lastId = 0;
  /** Rows dropped from the head since the previous `read`. */
  let droppedSinceRead = 0;

  const nextId = (): number => {
    lastId += 1;
    return lastId;
  };

  const nowIso = (): string => clock().toISOString();

  /**
   * Appends a row and trims the head.
   *
   * The ring counts what it drops rather than hiding it. A reader that sees a
   * gap in the messages needs to know the gap is a capacity limit and not an
   * app that went quiet.
   */
  const push = (row: IosSimulatorLogRow): void => {
    rows.push(row);
    while (rows.length > capacity) {
      rows.shift();
      droppedSinceRead += 1;
    }
  };

  /** Ends the current run. The buffered rows stay readable. */
  const teardown = (): void => {
    const active = session;
    session = null;
    if (!active || !active.live) {
      return;
    }
    active.live = false;
    try {
      active.process.kill();
    } catch (error) {
      logger?.debug("ios_event_log.kill_failed", {
        deviceUdid: active.deviceUdid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    /**
     * Starts the log stream for a device.
     *
     * A start for the device AND the app that is already streaming is a no-op,
     * because the drawer re-asks on every mount and a second stream would
     * double every row.
     *
     * A start for a different device, or for a different app on the same
     * device, stops the old stream and clears the buffer. Rows from two apps
     * in one list are a lie: the list claims one timeline for one app, and
     * mixed rows make a person read a message from something they are not
     * looking at as if it came from what is on screen.
     *
     * The ids keep counting across the clear, so a `sinceId` from before the
     * switch never matches a row from after it.
     *
     * @throws Error when the bundle id cannot make a safe predicate.
     */
    start(args) {
      const requested = (args.deviceUdid ?? "").trim();
      if (requested.length === 0) {
        throw new Error("Cannot start the iOS event log without a device udid.");
      }
      const predicate = buildLogPredicate({ bundleId: args.bundleId });
      // The same device AND the same app is the drawer re-mounting, which must
      // not restart the stream. The same device with another app is a real
      // change: the caller moved to another bundle id and its rows have to
      // follow, so that falls through to a respawn.
      if (session?.live && session.deviceUdid === requested && session.predicate === predicate) {
        logger?.debug("ios_event_log.start_ignored", { deviceUdid: requested });
        return;
      }
      // The buffer belongs to one device AND one app, so either changing
      // clears it. Keyed on the device alone, a new app left the old app's
      // rows in the ring and the drawer rendered them under the new app's
      // header — the same lie as mixing two devices.
      const switched = deviceUdid !== null
        && (deviceUdid !== requested || bufferPredicate !== predicate);
      teardown();
      if (switched) {
        rows.length = 0;
        droppedSinceRead = 0;
      }
      bufferPredicate = predicate;
      deviceUdid = requested;
      lastError = null;

      const active: EventLogSession = {
        deviceUdid: requested,
        predicate,
        process: deps.spawnLogStream(requested, predicate),
        live: true,
      };
      session = active;
      active.process.onLine((line) => {
        if (!active.live) {
          return;
        }
        push(parseCompactLogLine(line, nextId(), nowIso()));
      });
      active.process.onError((error) => {
        if (!active.live) {
          return;
        }
        lastError = error.message;
        logger?.debug("ios_event_log.stream_error", {
          deviceUdid: requested,
          error: error.message,
        });
      });
      active.process.onExit((code) => {
        if (!active.live) {
          return;
        }
        // `log stream` runs until something kills it, so any exit ADE did not
        // ask for is a failure. The rows stay in the ring: the last lines
        // before the exit usually explain it.
        active.live = false;
        session = null;
        lastError =
          code === null
            ? "log stream exited without a status code."
            : `log stream exited with status ${code}.`;
        logger?.debug("ios_event_log.stream_exited", { deviceUdid: requested, code });
      });
      logger?.debug("ios_event_log.started", { deviceUdid: requested, predicate });
    },

    /** Stops the stream. The rows stay readable, so the drawer keeps its history. */
    stop() {
      const stopped = session?.deviceUdid ?? null;
      teardown();
      if (stopped) {
        logger?.debug("ios_event_log.stopped", { deviceUdid: stopped });
      }
    },

    isRunning() {
      return session?.live === true;
    },

    /**
     * The device the buffered rows come from.
     *
     * The value survives `stop` and a stream exit, because the rows survive
     * both. A page that reports rows with a null device gives the reader no way
     * to know whose rows they are.
     */
    activeDeviceUdid() {
      return deviceUdid;
    },

    record(row) {
      const entry: IosSimulatorLogRow = {
        id: nextId(),
        at: nowIso(),
        source: "ade",
        // "action" is the default because almost every ADE row reports a thing
        // ADE did. A caller passes a level only to report a failure.
        level: row.level ?? "action",
        process: null,
        subsystem: null,
        category: null,
        message: row.message,
        command: row.command ?? null,
      };
      push(entry);
      return entry;
    },

    /** The newest rows, with no page and no side effect. */
    snapshotRows(limit) {
      const count = clampReadLimit(limit);
      return rows.slice(Math.max(0, rows.length - count));
    },

    /**
     * Reads a page of rows in chronological order.
     *
     * Without `sinceId` the caller gets the newest rows, because a drawer that
     * opens late must show the present and not the start of the stream. With
     * `sinceId` the caller gets the oldest rows after that id, because a poll
     * must not skip the rows between two polls.
     *
     * `dropped` reports the rows lost since the previous `read` and then resets.
     * The count belongs to the page that hides the gap, and a count that never
     * reset would report the same gap forever. A reader that is not the one
     * showing the gap wants `snapshotRows` instead.
     */
    read(args) {
      const limit = clampReadLimit(args.limit);
      const sinceId = typeof args.sinceId === "number" ? args.sinceId : null;
      const page =
        sinceId === null
          ? rows.slice(Math.max(0, rows.length - limit))
          : rows.filter((row) => row.id > sinceId).slice(0, limit);
      const cursor = page.length > 0 ? page[page.length - 1].id : (sinceId ?? lastId);
      const dropped = droppedSinceRead;
      droppedSinceRead = 0;
      return {
        deviceUdid,
        running: session?.live === true,
        rows: page,
        cursor,
        dropped,
        lastError,
      };
    },

    /**
     * Releases everything.
     *
     * The process interface offers no unsubscribe call, so `teardown` clears
     * the `live` flag that every handler tests. That flag is how a handler is
     * dropped. The rows go too, because a disposed log has no reader left to
     * hold memory for.
     */
    dispose() {
      teardown();
      rows.length = 0;
      deviceUdid = null;
      bufferPredicate = null;
      droppedSinceRead = 0;
      lastError = null;
    },
  };
}
