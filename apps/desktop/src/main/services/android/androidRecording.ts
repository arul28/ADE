import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Muxer, StreamTarget } from "mp4-muxer";
import type {
  AndroidRecording,
  AndroidRecordingSegment,
  AndroidRecordingStopReason,
} from "../../../shared/types/androidEmulator";
import { ANDROID_RECORDING_MAX_SECONDS } from "../../../shared/types/androidEmulator";
import { createH264AnnexBParser } from "../media/h264AnnexB";
import type { ScrcpyVideoPacket } from "./scrcpyVideo";

/*
 * Recording the lane's emulator into MP4, from the scrcpy stream the brain
 * already runs for the live view.
 *
 * Why the stream and not `adb shell screenrecord`: the emulator has only a
 * software H.264 encoder, and a second one would cost the guest about the
 * CPU the live view costs (~270% of a core, plan §9). The stream follows a
 * rotation, has no 3-minute limit, runs the same on every host, and its
 * packets carry the encoder's own timestamps. The cost is its size: the
 * stream's picture (1024 px on the long side by default).
 *
 * How it muxes: each packet is Annex B (start codes). MP4 wants each NAL with
 * a 4-byte length instead, and the SPS and PPS in an `avcC` box. `mp4-muxer`
 * (pure JS, already a desktop dependency) writes the boxes; this file writes
 * its output straight to disk, so a long recording never sits in memory.
 *
 * - A segment starts at a keyframe, so its first frame decodes.
 * - A config with a new size (a rotation) ends the segment and starts the
 *   next: one MP4 track keeps one size. The same size with new parameter sets
 *   (an encoder reset) goes on in the same file, with the new SPS and PPS in
 *   the keyframe's sample.
 * - Timestamps start at 0. A stream restart starts its timestamps again; the
 *   writer moves them on past the last frame, so time never runs backwards.
 *
 * Files: `<dataDir>/recordings/<lane>/<id>.mp4` (more segments as
 * `<id>-2.mp4`, …) and a `<id>.json` sidecar with the `AndroidRecording`.
 *
 * Node built-ins, `mp4-muxer` and relative imports only, so it runs under `tsx`.
 */

const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;
/** The last frame's length in the file; the encoder sends no end time. */
const LAST_FRAME_US = 33_333;
/** A frame that comes no later than the one before it gets this much after it. */
const MIN_FRAME_STEP_US = 1_000;

/** The NAL payloads (no start code) of an Annex B buffer. */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const starts: Array<{ at: number; length: number }> = [];
  for (let i = 0; i + 2 < data.length; i += 1) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    if (data[i + 2] === 1) {
      starts.push({ at: i, length: 3 });
      i += 2;
    } else if (data[i + 2] === 0 && i + 3 < data.length && data[i + 3] === 1) {
      starts.push({ at: i, length: 4 });
      i += 3;
    }
  }
  const nals: Uint8Array[] = [];
  starts.forEach((start, index) => {
    const from = start.at + start.length;
    const to = index + 1 < starts.length ? starts[index + 1]!.at : data.length;
    if (to > from) nals.push(data.subarray(from, to));
  });
  return nals;
}

/** An `AVCDecoderConfigurationRecord` for one SPS and one PPS, 4-byte lengths. */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length);
  out[0] = 1;
  out[1] = sps[1] ?? 0x42;
  out[2] = sps[2] ?? 0;
  out[3] = sps[3] ?? 0x1e;
  out[4] = 0xff; // 6 reserved bits, then lengthSizeMinusOne = 3
  out[5] = 0xe1; // 3 reserved bits, then one SPS
  out[6] = (sps.length >> 8) & 0xff;
  out[7] = sps.length & 0xff;
  out.set(sps, 8);
  let at = 8 + sps.length;
  out[at] = 1; // one PPS
  out[at + 1] = (pps.length >> 8) & 0xff;
  out[at + 2] = pps.length & 0xff;
  at += 3;
  out.set(pps, at);
  return out;
}

/** NALs as one MP4 sample: each one led by its length (4 bytes, big-endian). */
export function toLengthPrefixed(nals: readonly Uint8Array[]): Uint8Array {
  const size = nals.reduce((sum, nal) => sum + 4 + nal.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const nal of nals) {
    out[at] = (nal.length >>> 24) & 0xff;
    out[at + 1] = (nal.length >>> 16) & 0xff;
    out[at + 2] = (nal.length >>> 8) & 0xff;
    out[at + 3] = nal.length & 0xff;
    out.set(nal, at + 4);
    at += 4 + nal.length;
  }
  return out;
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

type ParameterSets = { sps: Uint8Array; pps: Uint8Array; codec: string; width: number; height: number };

/** One MP4 file, written to disk as the muxer produces it. */
class SegmentWriter {
  private readonly fd: number;
  private readonly muxer: Muxer<StreamTarget>;
  private bytesWritten = 0;
  private frameCount = 0;
  private firstUs: number | null = null;
  private lastUs: number | null = null;
  /** How long the last written frame shows, in microseconds. */
  private lastDurationUs = 0;
  private wroteConfig = false;
  private closed = false;
  /**
   * The newest frame, held back until the next one (or the end) says how long
   * it shows. The emulator sends a frame only when the screen changes, so a
   * still screen is one frame that must last until the next change or the stop.
   */
  private pending: { sample: Uint8Array; keyframe: boolean; timeUs: number; wallMs: number } | null = null;

  constructor(readonly filePath: string, readonly sets: ParameterSets) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.fd = fs.openSync(filePath, "w");
    this.muxer = new Muxer({
      target: new StreamTarget({
        onData: (data, position) => {
          fs.writeSync(this.fd, data, 0, data.length, position);
          this.bytesWritten = Math.max(this.bytesWritten, position + data.length);
        },
      }),
      video: { codec: "avc", width: sets.width, height: sets.height },
      // Metadata at the end: no frame is held in memory until the stop.
      fastStart: false,
      firstTimestampBehavior: "offset",
    });
  }

  get frames(): number {
    return this.frameCount;
  }

  /** The time this segment covers so far, in microseconds (the held frame counts until now). */
  spanUs(nowMs = Date.now()): number {
    if (this.firstUs === null) return 0;
    if (this.pending) return this.pending.timeUs - this.firstUs + Math.max(LAST_FRAME_US, (nowMs - this.pending.wallMs) * 1000);
    return (this.lastUs ?? this.firstUs) - this.firstUs + this.lastDurationUs;
  }

  add(sample: Uint8Array, keyframe: boolean, timeUs: number, wallMs = Date.now()): void {
    if (this.closed) return;
    if (this.pending) this.write(this.pending, timeUs - this.pending.timeUs);
    this.firstUs ??= timeUs;
    this.pending = { sample, keyframe, timeUs, wallMs };
    this.frameCount += 1;
  }

  private write(frame: { sample: Uint8Array; keyframe: boolean; timeUs: number }, durationUs: number): void {
    const meta = this.wroteConfig
      ? undefined
      : {
        decoderConfig: {
          codec: this.sets.codec,
          codedWidth: this.sets.width,
          codedHeight: this.sets.height,
          description: buildAvcC(this.sets.sps, this.sets.pps),
        },
      };
    this.muxer.addVideoChunkRaw(frame.sample, frame.keyframe ? "key" : "delta", frame.timeUs, durationUs, meta as never);
    this.wroteConfig = true;
    this.lastUs = frame.timeUs;
    this.lastDurationUs = durationUs;
  }

  /**
   * Writes the held frame (it shows until `endWallMs`), the index, and closes
   * the file. Null when it holds no frame (the file is removed).
   */
  finish(endWallMs = Date.now()): AndroidRecordingSegment | null {
    if (this.closed) return null;
    try {
      if (this.pending) {
        this.write(this.pending, Math.max(LAST_FRAME_US, Math.round((endWallMs - this.pending.wallMs) * 1000)));
        this.pending = null;
      }
    } finally {
      this.closed = true;
    }
    try {
      if (this.frameCount > 0) this.muxer.finalize();
    } finally {
      fs.closeSync(this.fd);
    }
    if (this.frameCount === 0) {
      fs.rmSync(this.filePath, { force: true });
      return null;
    }
    return {
      path: this.filePath,
      width: this.sets.width,
      height: this.sets.height,
      durationMs: Math.round(this.spanUs() / 1000),
      bytes: this.bytesWritten,
      frames: this.frameCount,
    };
  }

  /** Closes and removes the file without writing an index (a discard). */
  abandon(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.closeSync(this.fd);
    } finally {
      fs.rmSync(this.filePath, { force: true });
    }
  }
}

/**
 * Turns one recording's stream packets into MP4 segments. Pure of the stream:
 * the caller feeds it every packet the hub hands out for the emulator.
 */
export function createAndroidMp4Recorder(input: { basePath: string }) {
  const segments: AndroidRecordingSegment[] = [];
  let sets: ParameterSets | null = null;
  /** New parameter sets of the same size, to put in front of the next keyframe. */
  let pendingInBand: ParameterSets | null = null;
  let writer: SegmentWriter | null = null;
  /** Microseconds already written before the current stream's timestamps began. */
  let offsetUs = 0;
  let lastUs: number | null = null;
  let lastRawUs: number | null = null;
  let finished = false;

  const segmentPath = () => (segments.length === 0 && !writer
    ? `${input.basePath}.mp4`
    : `${input.basePath}-${segments.length + (writer ? 2 : 1)}.mp4`);

  const closeWriter = () => {
    const done = writer?.finish() ?? null;
    if (done) segments.push(done);
    writer = null;
  };

  const readConfig = (data: Uint8Array): ParameterSets | null => {
    const parser = createH264AnnexBParser();
    parser.push(data);
    parser.flush();
    const parsed = parser.parameterSets();
    if (!parsed.sps || !parsed.pps || !parsed.width || !parsed.height) return null;
    return { sps: parsed.sps, pps: parsed.pps, codec: parsed.codec ?? "avc1.42e01e", width: parsed.width, height: parsed.height };
  };

  return {
    push(packet: Pick<ScrcpyVideoPacket, "config" | "keyframe" | "ptsUs" | "data">): void {
      if (finished) return;
      if (packet.config) {
        const next = readConfig(packet.data);
        if (!next) return;
        if (writer && (next.width !== writer.sets.width || next.height !== writer.sets.height)) {
          // A rotation: one MP4 track keeps one size.
          closeWriter();
        } else if (writer && !(sameBytes(next.sps, writer.sets.sps) && sameBytes(next.pps, writer.sets.pps))) {
          pendingInBand = next;
        }
        sets = next;
        return;
      }
      if (!sets || packet.ptsUs === null) return;
      if (!writer) {
        // A segment starts at a keyframe, or its first frames cannot decode.
        if (!packet.keyframe) return;
        writer = new SegmentWriter(segmentPath(), sets);
        pendingInBand = null;
      }
      const raw = packet.ptsUs;
      // A restarted stream counts from 0 again: carry on after the last frame.
      if (lastRawUs !== null && lastUs !== null && raw <= lastRawUs) offsetUs = lastUs + LAST_FRAME_US - raw;
      let timeUs = raw + offsetUs;
      if (lastUs !== null && timeUs <= lastUs) timeUs = lastUs + MIN_FRAME_STEP_US;
      lastRawUs = raw;
      lastUs = timeUs;
      let nals = splitAnnexB(packet.data).filter((nal) => {
        const type = (nal[0] ?? 0) & 0x1f;
        return type !== NAL_SPS && type !== NAL_PPS && type !== NAL_AUD;
      });
      if (packet.keyframe && pendingInBand) {
        nals = [pendingInBand.sps, pendingInBand.pps, ...nals];
        pendingInBand = null;
      }
      if (nals.length === 0) return;
      writer.add(toLengthPrefixed(nals), packet.keyframe, timeUs);
    },

    /** The time recorded so far, in milliseconds. */
    elapsedMs(): number {
      const closed = segments.reduce((sum, segment) => sum + segment.durationMs, 0);
      return closed + Math.round((writer?.spanUs() ?? 0) / 1000);
    },

    finish(): AndroidRecordingSegment[] {
      if (!finished) {
        finished = true;
        closeWriter();
      }
      return [...segments];
    },

    abandon(): void {
      finished = true;
      writer?.abandon();
      writer = null;
      for (const segment of segments) fs.rmSync(segment.path, { force: true });
      segments.length = 0;
    },
  };
}

/* ---------- the store ---------- */

/** A lane id as a folder name. */
function laneFolder(laneId: string): string {
  return laneId.replace(/[^A-Za-z0-9_-]+/gu, "_") || "lane";
}

export function androidRecordingsDir(dataDir: string, laneId: string): string {
  return path.join(dataDir, "recordings", laneFolder(laneId));
}

export function newAndroidRecordingId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
}

export function writeAndroidRecordingSidecar(dataDir: string, recording: AndroidRecording): void {
  const dir = androidRecordingsDir(dataDir, recording.laneId);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${recording.id}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(recording, null, 2)}\n`);
  fs.renameSync(temp, target);
}

/** The lane's finished recordings, newest first. A sidecar that does not parse is skipped. */
export function listAndroidRecordings(dataDir: string, laneId: string): AndroidRecording[] {
  const dir = androidRecordingsDir(dataDir, laneId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: AndroidRecording[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as AndroidRecording;
      if (parsed && typeof parsed.id === "string" && parsed.laneId === laneId) out.push({ ...parsed, active: false });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Removes a finished recording's files and sidecar. False when there is no such recording. */
export function deleteAndroidRecording(dataDir: string, laneId: string, id: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) return false;
  const dir = androidRecordingsDir(dataDir, laneId);
  const sidecar = path.join(dir, `${id}.json`);
  const known = listAndroidRecordings(dataDir, laneId).find((recording) => recording.id === id) ?? null;
  if (!known && !fs.existsSync(path.join(dir, `${id}.mp4`))) return false;
  const files = new Set<string>([path.join(dir, `${id}.mp4`), sidecar]);
  for (const segment of known?.segments ?? []) {
    // Only files inside the lane's folder: a sidecar is data, not a delete list.
    if (path.dirname(path.resolve(segment.path)) === path.resolve(dir)) files.add(segment.path);
  }
  for (const file of files) fs.rmSync(file, { force: true });
  return true;
}

/** The cap a recording runs to: the caller's `maxSeconds`, at most five minutes. */
export function androidRecordingCapMs(maxSeconds: number | null | undefined): number {
  const asked = typeof maxSeconds === "number" && Number.isFinite(maxSeconds) && maxSeconds > 0 ? maxSeconds : ANDROID_RECORDING_MAX_SECONDS;
  return Math.round(Math.min(asked, ANDROID_RECORDING_MAX_SECONDS) * 1000);
}

export type { AndroidRecordingStopReason };
