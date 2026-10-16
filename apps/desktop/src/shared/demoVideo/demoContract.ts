/**
 * The demo-video contract: what a recording logs, what a render engine
 * measures, and the plan it executes.
 *
 * Every recording ADE files is a demo unless the caller asked for `plain`:
 *
 * 1. The recorder writes a RAW file at wall-clock time, with no idle cut and
 *    no overlays, into a temporary cache folder.
 * 2. While it records, the brain logs a {@link DemoTrack}: the actions on the
 *    screen (clicks, taps, typing, navigation), the agent's own state
 *    (thinking or waiting on a tool), page loads, and step captions.
 * 3. When it stops, a render engine measures the raw file
 *    ({@link DemoAnalysis}), the planner (`demoPlanner.ts`, pure) turns track
 *    and analysis into a {@link DemoPlan}, and the engine executes the plan
 *    into the demo MP4. The raw file is then deleted: ADE never keeps two
 *    files of one recording.
 *
 * Two engines execute the same plan, so a demo looks the same on every OS:
 *
 * - `swift`: `ade-media` (`native/ADEMedia`), macOS only. It reads MP4/MOV
 *   (the Apple helper, the Mac Desktop driver and App Control's window
 *   recording) and works in the headless brain.
 * - `chromium`: a hidden renderer in the ADE desktop app, any OS. It reads
 *   the {@link DEMO_RAW_FILE_EXTENSION} capture that the browser recorder and
 *   App Control's screencast recorder write.
 *
 * Pure types and constants: imported by the brain, the desktop main process,
 * the hidden renderer and tests. No Node or DOM imports here.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Every demo, plain ones included, ends under GitHub Free's 10 MB video limit. */
export const DEMO_MAX_BYTES = 10 * 1024 * 1024;
/** What the size fit aims at: the encoders' average bitrate is not exact. */
export const DEMO_TARGET_BYTES = 9_200_000;
/** Renders the size fit may try before it gives up and files the smallest. */
export const DEMO_MAX_RENDER_ATTEMPTS = 4;

/** No recording runs longer than this, whoever started it. */
export const RECORDING_MAX_MS = 5 * 60 * 1000;
/** A recording with no screen change and no action for this long stops and files itself. */
export const RECORDING_IDLE_STOP_MS = 2 * 60 * 1000;
/** A raw file this large stops its recording. */
export const RECORDING_MAX_RAW_BYTES = 2 * 1024 * 1024 * 1024;
/** Less free disk than this stops every recording on the volume. */
export const RECORDING_MIN_FREE_DISK_BYTES = 5 * 1024 * 1024 * 1024;
/**
 * A recording's stop makes its demo before it answers: measure the raw file,
 * render it, and render again when the first result is over 10 MB. A
 * five-minute recording takes well under a minute on Apple silicon; this
 * leaves room for a slow machine and the size refits. Every transport that
 * carries a stop (renderer IPC, the desktop bridge) waits at least this long.
 */
export const DEMO_RECORDING_STOP_TIMEOUT_MS = 4 * 60_000;

// ---------------------------------------------------------------------------
// The track: what the brain logs while a recording runs
// ---------------------------------------------------------------------------

export type DemoSurface = "apple" | "mac-desktop" | "app-control" | "browser";

/** A rectangle in normalized source coordinates: x, y, width, height, each 0..1. */
export type DemoRect = [number, number, number, number];

export type DemoTrackEventKind =
  | "click"
  | "tap"
  | "type"
  | "key"
  | "scroll"
  | "drag"
  | "navigate"
  /** A step caption: the agent's `ade proof step "<text>"`. */
  | "step";

export type DemoTrackEvent = {
  /** Seconds since the raw file's first frame. */
  t: number;
  kind: DemoTrackEventKind;
  /** The point acted on, normalized 0..1 in the source frame. */
  x?: number;
  y?: number;
  /** The element acted on, when the surface knows it. Normalized. */
  rect?: DemoRect;
  /**
   * A short label: the element's name for an action ("Save"), the typed text
   * for `type` (already shortened), the URL host for `navigate`, the caption
   * for `step`.
   */
  label?: string;
  by: "agent" | "user";
};

export type DemoAgentSpan = {
  start: number;
  end: number;
  /** `thinking`: no tool runs (the model is working). `tool`: a tool call runs. */
  state: "thinking" | "tool";
};

export type DemoTimeSpan = { start: number; end: number };

export type DemoTrack = {
  version: 1;
  surface: DemoSurface;
  /**
   * Seconds of source time. The recorder's first frame is 0; every other
   * time in this track is measured from it.
   */
  durationSeconds: number;
  events: DemoTrackEvent[];
  /** Only for a recording a chat owns. Empty for a person's own recording. */
  agentSpans: DemoAgentSpan[];
  /** Navigation start → load finished, for the browser and App Control. */
  loadSpans: DemoTimeSpan[];
  /**
   * The recording asked for zoom (`record start --zoom`). A phone recording
   * zooms only when this is true; the other surfaces zoom unless plain.
   */
  zoom?: boolean;
};

// ---------------------------------------------------------------------------
// The analysis: what an engine measures in the raw file (pass 1)
// ---------------------------------------------------------------------------

/**
 * How an engine measures change. Both engines use the same rules, so the
 * planner's thresholds mean the same thing on every OS:
 *
 * - Scale each decoded frame to greyscale, longest side
 *   {@link DEMO_ANALYSIS_THUMBNAIL_LONG_SIDE} px, by box average.
 * - A thumbnail pixel changed when its value differs from the same pixel of
 *   the previous analysed frame by more than {@link DEMO_ANALYSIS_PIXEL_DELTA}
 *   (0..255).
 * - `changed` is the fraction of pixels that changed; `box` is their bounding
 *   box, normalized. The first frame has `changed: 1` and no box.
 * - Frames closer than {@link DEMO_ANALYSIS_MIN_INTERVAL_SECONDS} to the last
 *   analysed one may be skipped; a skipped frame's change folds into the next.
 */
export const DEMO_ANALYSIS_THUMBNAIL_LONG_SIDE = 256;
export const DEMO_ANALYSIS_PIXEL_DELTA = 24;
export const DEMO_ANALYSIS_MIN_INTERVAL_SECONDS = 1 / 30;

export type DemoAnalysisFrame = {
  /** Seconds since the first frame (source time). */
  t: number;
  /** 0..1. */
  changed: number;
  box?: DemoRect;
};

export type DemoAnalysis = {
  version: 1;
  /** Pixel size of the raw frames. */
  width: number;
  height: number;
  /** Source time of the end of the file. */
  durationSeconds: number;
  frames: DemoAnalysisFrame[];
};

// ---------------------------------------------------------------------------
// The plan: what an engine executes (pass 2)
// ---------------------------------------------------------------------------

/**
 * One stretch of the output. Source times increase from one segment to the
 * next, so an engine decodes forward only. A source range that no segment
 * covers is cut. Speed is `(sourceEnd - sourceStart) / (outputEnd - outputStart)`:
 * 1 plays normally, more than 1 is a speed-up.
 */
export type DemoSegment = {
  outputStart: number;
  outputEnd: number;
  sourceStart: number;
  sourceEnd: number;
};

/**
 * The camera at an output time. `zoom` ≥ 1 (1 shows the whole frame).
 * `cx`/`cy` are the center of the visible viewport in normalized source
 * coordinates, already clamped so the viewport stays inside the frame. An
 * engine interpolates linearly between keys; the planner samples its easing
 * densely enough that linear is smooth.
 */
export type DemoCameraKey = { t: number; zoom: number; cx: number; cy: number };

/**
 * The drawn pointer at an output time, normalized source coordinates. Linear
 * between two visible keys; hidden while `visible` is false.
 */
export type DemoCursorKey = { t: number; x: number; y: number; visible: boolean };

/** A click ring, starting at output time `t`, at a normalized source point. */
export type DemoRing = { t: number; x: number; y: number };

/** Text drawn at the bottom center of the output, over the picture. */
export type DemoCaption = { start: number; end: number; text: string };

/** The small speed badge ("4×") in the top right corner of the output. */
export type DemoBadge = { start: number; end: number; text: string };

/**
 * How overlays look. Sizes are fractions of the OUTPUT frame's shorter side,
 * so they read the same at any output size. Both engines draw the same shapes.
 */
export type DemoStyle = {
  /** `#RRGGBB`, the ADE accent. Rings and the caption's accent bar. */
  accent: string;
  ringDurationSeconds: number;
  ringStartRadius: number;
  ringEndRadius: number;
  ringLineWidth: number;
  /** Pointer height. The pointer is {@link DEMO_POINTER_POLYGON}, white with a dark outline. */
  pointerHeight: number;
  captionFontSize: number;
  /** Gap between the caption's box and the bottom edge. */
  captionMargin: number;
  badgeFontSize: number;
};

/**
 * The pointer, as a polygon in pointer units: (0,0) is the tip, the shape is
 * 1 unit tall. Scale by `pointerHeight × shorter side`. Fill white, stroke
 * `#111111` at 0.06 units.
 */
export const DEMO_POINTER_POLYGON: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 0.78],
  [0.2, 0.6],
  [0.33, 0.9],
  [0.45, 0.85],
  [0.32, 0.56],
  [0.56, 0.56],
];

export type DemoOutput = {
  /** Even numbers. */
  width: number;
  height: number;
  fps: number;
  /** Average bits per second for H.264. */
  bitrate: number;
  keyframeIntervalSeconds: number;
};

export type DemoPlan = {
  version: 1;
  source: { width: number; height: number };
  output: DemoOutput;
  /** Output length, seconds. Equals the last segment's `outputEnd`. */
  durationSeconds: number;
  segments: DemoSegment[];
  camera: DemoCameraKey[];
  cursor: DemoCursorKey[];
  rings: DemoRing[];
  captions: DemoCaption[];
  badges: DemoBadge[];
  style: DemoStyle;
};

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

export type DemoEngineId = "swift" | "chromium";

/**
 * The raw capture the Chromium-side recorders write, readable by the chromium
 * engine without a demuxer. Layout, little-endian:
 *
 * - header: the 8 ASCII bytes `ADERAW1\n`;
 * - then records: u8 kind, u8 flags (bit 0 = keyframe), u16 reserved,
 *   f64 source time in seconds, u32 payload length, payload.
 *
 * Kinds: 1 = a JPEG frame; 2 = H.264 decoder config, payload JSON
 * `{codec, width, height}` (Annex-B stream, no description); 3 = one H.264
 * access unit, Annex-B. A file holds JPEG frames or H.264, not both.
 */
export const DEMO_RAW_FILE_EXTENSION = ".aderaw";
export const DEMO_RAW_FILE_MAGIC = "ADERAW1\n";
export const DEMO_RAW_RECORD_HEADER_BYTES = 16;
export const DEMO_RAW_KIND_JPEG = 1;
export const DEMO_RAW_KIND_H264_CONFIG = 2;
export const DEMO_RAW_KIND_H264_ACCESS_UNIT = 3;
export const DEMO_RAW_FLAG_KEYFRAME = 1;

export type DemoRenderRequest = {
  input: string;
  output: string;
  plan: DemoPlan;
};

export type DemoRenderResult = {
  bytes: number;
  durationSeconds: number;
  frames: number;
};

/** One engine. Implementations reject with an Error whose message is readable. */
export type DemoEngine = {
  id: DemoEngineId;
  /** True when this engine can read `inputPath` (by extension). */
  canRead(inputPath: string): boolean;
  analyze(inputPath: string, options?: { signal?: AbortSignal }): Promise<DemoAnalysis>;
  render(request: DemoRenderRequest, options?: { signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<DemoRenderResult>;
};

// ---------------------------------------------------------------------------
// What a filed demo records about itself
// ---------------------------------------------------------------------------

/** Stored at `metadata.demo` on the proof artifact. */
export type DemoArtifactMetadata = {
  plain: boolean;
  engine: DemoEngineId | null;
  /** Wall-clock seconds the raw recording covered. */
  sourceSeconds: number;
  /** Output length. */
  outputSeconds: number;
  cutSeconds: number;
  spedUpSourceSeconds: number;
  /** Chapters for ADE's player: the step captions, in output time. */
  steps: Array<{ t: number; text: string }>;
  /** Set when the render failed and the raw file was filed instead. */
  fallbackReason?: string;
};
