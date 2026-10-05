/**
 * The `chromium` demo engine: measures and renders an `.aderaw` capture, or
 * an H.264 MP4 (the Windows desktop driver's recording, served as `.aderaw`
 * records by `demoMp4Source.ts`), in a hidden renderer of the ADE desktop
 * app, on any OS.
 *
 * Electron main process only: it imports `electron`. The runtime daemon
 * reaches it over the desktop bridge (`demo_engine.*`); a machine with no
 * desktop app has no Chromium engine.
 *
 * How one job runs:
 *
 * - A hidden, sandboxed window in a private in-memory partition loads a page
 *   this module serves itself (`https://ade-demo-engine.invalid/<token>/`,
 *   answered by `protocol.handle` on that partition only; nothing reaches the
 *   network). https because WebCodecs exists only in a secure context, and a
 *   `data:` or `about:blank` page is not one.
 * - The page streams the raw file from the same handler with `fetch`, so the
 *   file is never held whole on either side (a capture can reach 2 GB).
 * - It decodes (JPEG → `createImageBitmap`, H.264 → `VideoDecoder`, Annex-B),
 *   and either measures change (the contract's analysis rules) or draws the
 *   plan's frames on an OffscreenCanvas and encodes them with `VideoEncoder`.
 * - Main pulls the results with `executeJavaScript` (structured clone, so the
 *   encoded chunks come back as bytes, not base64) and muxes the MP4 here with
 *   `mp4-muxer`, then writes it to a temporary name and renames it into place.
 *
 * One window per job, one job at a time per engine. Abort, a stall, a crashed
 * renderer and a decode or encode error all reject with a readable message
 * and destroy the window.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { BrowserWindow, session as electronSession } from "electron";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import {
  DEMO_ANALYSIS_MIN_INTERVAL_SECONDS,
  DEMO_ANALYSIS_PIXEL_DELTA,
  DEMO_ANALYSIS_THUMBNAIL_LONG_SIDE,
  DEMO_POINTER_POLYGON,
  DEMO_RAW_FILE_EXTENSION,
  DEMO_RAW_FILE_MAGIC,
  DEMO_RAW_FLAG_KEYFRAME,
  DEMO_RAW_KIND_H264_ACCESS_UNIT,
  DEMO_RAW_KIND_H264_CONFIG,
  DEMO_RAW_KIND_JPEG,
  DEMO_RAW_RECORD_HEADER_BYTES,
  type DemoAnalysis,
  type DemoEngine,
  type DemoPlan,
  type DemoRenderRequest,
  type DemoRenderResult,
} from "../../../shared/demoVideo/demoContract";
import type { Logger } from "../logging/logger";
import { type DemoMp4Info, demoRawStreamFromMp4, isDemoMp4Path, readDemoMp4 } from "./demoMp4Source";
import { DEMO_RAW_MAX_PAYLOAD_BYTES, hasDemoRawMagic } from "./demoRawFormat";

const PARTITION = "ade-demo-engine";
const ORIGIN_HOST = "ade-demo-engine.invalid";
/** Loading the page and installing the script. */
const SETUP_TIMEOUT_MS = 20_000;
/** A job whose progress does not move for this long is wedged. */
const STALL_TIMEOUT_MS = 60_000;
/** No job may run longer than this, whatever it reports. */
const JOB_TIMEOUT_MS = 30 * 60_000;
/** Renames of the finished file retry this often on Windows sharing errors. */
const RENAME_ATTEMPTS = 10;

/**
 * Runs inside the hidden renderer. Plain script, no imports, no template
 * literals: it is evaluated with `executeJavaScript`.
 *
 * The raw-file framing constants are the contract's, interpolated below;
 * `demoRawFormat.ts` writes the file.
 */
const ENGINE_SOURCE = String.raw`
(() => {
  if (window.__adeDemoEngine) return true;
  var MAGIC = ${JSON.stringify(DEMO_RAW_FILE_MAGIC)};
  var HEADER = ${DEMO_RAW_RECORD_HEADER_BYTES};
  var KIND_JPEG = ${DEMO_RAW_KIND_JPEG}, KIND_CONFIG = ${DEMO_RAW_KIND_H264_CONFIG}, KIND_AU = ${DEMO_RAW_KIND_H264_ACCESS_UNIT}, FLAG_KEY = ${DEMO_RAW_FLAG_KEYFRAME};
  var MAX_PAYLOAD = ${DEMO_RAW_MAX_PAYLOAD_BYTES};
  var OUTBOX_LIMIT = 8 * 1024 * 1024;

  var state = {
    outbox: [], outBytes: 0, progress: 0, done: false, result: null, error: null,
    waiter: null, spaceWaiters: [], cancelled: false,
  };
  function wake() {
    var waiter = state.waiter;
    state.waiter = null;
    if (waiter) waiter();
  }
  function fail(error) {
    if (state.error || state.done) return;
    state.error = error && error.message ? error.message : String(error);
    wake();
    var waiters = state.spaceWaiters.splice(0);
    for (var i = 0; i < waiters.length; i += 1) waiters[i]();
  }
  function checkCancelled() {
    if (state.cancelled) throw new Error("cancelled");
    if (state.error) throw new Error(state.error);
  }
  function send(item, bytes) {
    state.outbox.push(item);
    state.outBytes += bytes;
    wake();
  }
  async function waitForSpace() {
    while (state.outBytes > OUTBOX_LIMIT && !state.cancelled && !state.error) {
      await new Promise(function (resolve) { state.spaceWaiters.push(resolve); });
    }
  }

  // -- The raw file, streamed ------------------------------------------------

  function openRecords(url, onBytes) {
    var reader = null;
    var chunks = [];
    var available = 0;
    var sawMagic = false;
    var ended = false;
    function take(count) {
      var out = new Uint8Array(count);
      var offset = 0;
      while (offset < count) {
        var head = chunks[0];
        var need = count - offset;
        if (head.byteLength <= need) {
          out.set(head, offset);
          offset += head.byteLength;
          chunks.shift();
        } else {
          out.set(head.subarray(0, need), offset);
          chunks[0] = head.subarray(need);
          offset += need;
        }
      }
      available -= count;
      return out;
    }
    function peek(count) {
      var out = new Uint8Array(count);
      var offset = 0;
      for (var i = 0; i < chunks.length && offset < count; i += 1) {
        var n = Math.min(chunks[i].byteLength, count - offset);
        out.set(chunks[i].subarray(0, n), offset);
        offset += n;
      }
      return out;
    }
    function parseOne() {
      if (!sawMagic) {
        if (available < MAGIC.length) return null;
        var magic = take(MAGIC.length);
        for (var i = 0; i < MAGIC.length; i += 1) {
          if (magic[i] !== MAGIC.charCodeAt(i)) throw new Error("This file is not an ADE raw capture (bad header).");
        }
        sawMagic = true;
      }
      if (available < HEADER) return null;
      var header = peek(HEADER);
      var view = new DataView(header.buffer);
      var kind = view.getUint8(0);
      var flags = view.getUint8(1);
      var t = view.getFloat64(4, true);
      var length = view.getUint32(12, true);
      if (kind !== KIND_JPEG && kind !== KIND_CONFIG && kind !== KIND_AU) {
        throw new Error("The raw capture has a record of unknown kind " + kind + ".");
      }
      if (!isFinite(t) || length > MAX_PAYLOAD) throw new Error("The raw capture is corrupt (impossible record header).");
      if (available < HEADER + length) return null;
      take(HEADER);
      return { kind: kind, flags: flags, t: t, payload: take(length) };
    }
    return {
      async next() {
        for (;;) {
          var record = parseOne();
          if (record) return record;
          if (ended) {
            // A recorder that died mid-write leaves half a record: stop at the last whole one.
            if (!sawMagic) throw new Error("The raw capture is empty.");
            return null;
          }
          if (!reader) {
            var response = await fetch(url);
            if (!response.ok || !response.body) throw new Error("The raw capture could not be opened (HTTP " + response.status + ").");
            reader = response.body.getReader();
          }
          var step = await reader.read();
          if (step.done) {
            ended = true;
            continue;
          }
          chunks.push(step.value);
          available += step.value.byteLength;
          if (onBytes) onBytes(step.value.byteLength);
        }
      },
      close() {
        if (reader) reader.cancel().catch(function () {});
      },
    };
  }

  /**
   * Pictures in source-time order. Each item: { t, width, height,
   * image(): Promise<CanvasImageSource>, close() }. A JPEG decodes only when
   * its image is asked for, so a render skips the frames it never shows.
   */
  function openFrames(url, onBytes) {
    var records = openRecords(url, onBytes);
    var decoder = null;
    var decodeError = null;
    var decoded = [];
    var needKey = true;
    var ended = false;
    var outputWaiter = null;
    function notifyOutput() {
      var waiter = outputWaiter;
      outputWaiter = null;
      if (waiter) waiter();
    }
    function jpegItem(record) {
      var bitmap = null;
      var closed = false;
      return {
        t: record.t,
        async image() {
          if (!bitmap) bitmap = await createImageBitmap(new Blob([record.payload]));
          return bitmap;
        },
        close() {
          if (closed) return;
          closed = true;
          if (bitmap) bitmap.close();
          bitmap = null;
        },
      };
    }
    function videoItem(frame) {
      var closed = false;
      return {
        t: frame.timestamp / 1e6,
        async image() { return frame; },
        close() {
          if (closed) return;
          closed = true;
          frame.close();
        },
      };
    }
    async function configure(record) {
      var text = new TextDecoder().decode(record.payload);
      var config = JSON.parse(text);
      if (!config || typeof config.codec !== "string") throw new Error("The raw capture's H.264 config is unreadable.");
      if (decoder && decoder.state === "configured") await decoder.flush();
      if (!decoder) {
        decoder = new VideoDecoder({
          output: function (frame) { decoded.push(frame); notifyOutput(); },
          error: function (error) { decodeError = error; notifyOutput(); },
        });
      }
      var decoderConfig = { codec: config.codec, hardwareAcceleration: "no-preference" };
      if (config.width > 0 && config.height > 0) {
        decoderConfig.codedWidth = config.width;
        decoderConfig.codedHeight = config.height;
      }
      var support = await VideoDecoder.isConfigSupported(decoderConfig);
      if (!support.supported) throw new Error("This machine cannot decode the recording's video (" + config.codec + ").");
      decoder.configure(decoderConfig);
      needKey = true;
    }
    return {
      async next() {
        for (;;) {
          if (decodeError) throw new Error("The recording's video could not be decoded: " + (decodeError.message || decodeError));
          if (decoded.length) return videoItem(decoded.shift());
          if (ended) return null;
          var record = await records.next();
          if (!record) {
            ended = true;
            if (decoder && decoder.state === "configured") await decoder.flush();
            continue;
          }
          if (record.kind === KIND_JPEG) return jpegItem(record);
          if (record.kind === KIND_CONFIG) {
            await configure(record);
            continue;
          }
          if (!decoder || decoder.state !== "configured") throw new Error("The raw capture has H.264 before its config.");
          var key = (record.flags & FLAG_KEY) === FLAG_KEY;
          // A decoder refuses a delta frame before its first key frame.
          if (needKey && !key) continue;
          needKey = false;
          decoder.decode(new EncodedVideoChunk({
            type: key ? "key" : "delta",
            timestamp: Math.round(record.t * 1e6),
            data: record.payload,
          }));
          while (decoder.decodeQueueSize > 4 && !decoded.length && !decodeError) {
            await new Promise(function (resolve) {
              outputWaiter = resolve;
              decoder.addEventListener("dequeue", function () { resolve(); }, { once: true });
            });
          }
        }
      },
      close() {
        records.close();
        for (var i = 0; i < decoded.length; i += 1) decoded[i].close();
        decoded = [];
        if (decoder && decoder.state !== "closed") {
          try { decoder.close(); } catch (error) { /* already closed */ }
        }
      },
    };
  }

  function sizeOf(image) {
    return {
      width: image.displayWidth || image.width || 0,
      height: image.displayHeight || image.height || 0,
    };
  }

  // -- Pass 1: analysis ------------------------------------------------------

  async function analyze(job) {
    var side = job.thumbnailLongSide;
    var delta = job.pixelDelta;
    var canvas = null;
    var ctx = null;
    var read = 0;
    var frames = openFrames(job.rawUrl, function (bytes) {
      read += bytes;
      state.progress = job.size > 0 ? Math.min(0.999, read / job.size) : 0;
    });
    var result = { version: 1, width: 0, height: 0, durationSeconds: 0, frames: [] };
    var previous = null;
    var lastT = -Infinity;
    var held = null;

    // The contract's thumbnail, as ade-media computes it: size
    // round(side x W / longest) (never scaled up), each pixel in cell
    // floor(x * w / W), the plain mean of its cell, BT.709 luma in 8-bit fixed
    // point (54R + 183G + 19B) / 256, rounded once per cell. Like ade-media,
    // a source larger than 4x the thumbnail is first scaled to 4x (a grey
    // level or so off at sharp edges, far under the change threshold).
    var cellX = null;
    var cellY = null;
    var sums = null;
    var counts = null;
    function thumbnail(image) {
      var size = sizeOf(image);
      var longest = Math.max(size.width, size.height);
      var outW = longest <= side ? size.width : Math.max(1, Math.round(size.width * side / longest));
      var outH = longest <= side ? size.height : Math.max(1, Math.round(size.height * side / longest));
      var W = Math.min(size.width, outW * 4);
      var H = Math.min(size.height, outH * 4);
      if (!canvas || canvas.width !== W || canvas.height !== H) {
        canvas = new OffscreenCanvas(W, H);
        ctx = canvas.getContext("2d", { willReadFrequently: true });
      }
      if (!cellX || cellX.length !== W || cellY.length !== H || sums.length !== outW * outH) {
        cellX = new Uint32Array(W);
        cellY = new Uint32Array(H);
        for (var x0 = 0; x0 < W; x0 += 1) cellX[x0] = Math.floor(x0 * outW / W);
        for (var y0 = 0; y0 < H; y0 += 1) cellY[y0] = Math.floor(y0 * outH / H) * outW;
        sums = new Float64Array(outW * outH);
        counts = new Uint32Array(outW * outH);
        for (var cy = 0; cy < H; cy += 1) {
          for (var cx = 0; cx < W; cx += 1) counts[cellY[cy] + cellX[cx]] += 1;
        }
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, 0, 0, W, H);
      var data = ctx.getImageData(0, 0, W, H).data;
      sums.fill(0);
      var o = 0;
      for (var y = 0; y < H; y += 1) {
        var rowCell = cellY[y];
        for (var x = 0; x < W; x += 1, o += 4) {
          sums[rowCell + cellX[x]] += 54 * data[o] + 183 * data[o + 1] + 19 * data[o + 2];
        }
      }
      var luma = new Uint8Array(outW * outH);
      for (var i = 0; i < luma.length; i += 1) luma[i] = Math.min(255, Math.round(sums[i] / (256 * counts[i])));
      return { width: outW, height: outH, luma: luma, sourceWidth: size.width, sourceHeight: size.height };
    }

    function round5(value) {
      return Math.round(value * 1e5) / 1e5;
    }

    async function measure(item) {
      var thumb = thumbnail(await item.image());
      if (!result.width) {
        result.width = thumb.sourceWidth;
        result.height = thumb.sourceHeight;
      }
      if (!previous) {
        result.frames.push({ t: round5(item.t), changed: 1 });
      } else if (previous.width !== thumb.width || previous.height !== thumb.height) {
        // A resized source is all new.
        result.frames.push({ t: round5(item.t), changed: 1, box: [0, 0, 1, 1] });
      } else {
        var changed = 0;
        var minX = thumb.width, minY = thumb.height, maxX = -1, maxY = -1;
        for (var i = 0; i < thumb.luma.length; i += 1) {
          var d = thumb.luma[i] - previous.luma[i];
          if (d > delta || d < -delta) {
            changed += 1;
            var px = i % thumb.width;
            var py = (i - px) / thumb.width;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
          }
        }
        var frame = { t: round5(item.t), changed: round5(changed / thumb.luma.length) };
        if (changed > 0) {
          frame.box = [
            round5(minX / thumb.width),
            round5(minY / thumb.height),
            round5((maxX + 1 - minX) / thumb.width),
            round5((maxY + 1 - minY) / thumb.height),
          ];
        }
        result.frames.push(frame);
      }
      previous = thumb;
      lastT = item.t;
    }

    try {
      for (;;) {
        checkCancelled();
        var item = await frames.next();
        if (!item) break;
        result.durationSeconds = Math.max(result.durationSeconds, round5(item.t));
        if (result.frames.length && item.t - lastT < job.minInterval) {
          // Skipped; its change folds into the next analysed frame. The file's
          // last frame is analysed even when it is close to the one before.
          if (held) held.close();
          held = item;
          continue;
        }
        if (held) {
          held.close();
          held = null;
        }
        try {
          await measure(item);
        } finally {
          item.close();
        }
      }
      if (held) {
        try {
          await measure(held);
        } finally {
          held.close();
          held = null;
        }
      }
    } finally {
      if (held) held.close();
      frames.close();
    }
    if (!result.frames.length) throw new Error("The recording has no frames.");
    state.result = result;
    state.progress = 1;
  }

  // -- Pass 2: render --------------------------------------------------------

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function finiteKeys(list, fields) {
    return (list || []).filter(function (key) {
      for (var i = 0; i < fields.length; i += 1) {
        if (typeof key[fields[i]] !== "number" || !isFinite(key[fields[i]])) return false;
      }
      return true;
    });
  }

  /** The item of the list showing at T that started last, or null. Empty text is never shown. */
  function latestShowing(list, T) {
    var best = null;
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (!item.text || T < item.start || T >= item.end) continue;
      if (!best || item.start >= best.start) best = item;
    }
    return best;
  }

  function createRender(plan) {
    var segments = plan.segments || [];
    var camera = finiteKeys(plan.camera, ["t", "zoom", "cx", "cy"]);
    var cursor = finiteKeys(plan.cursor, ["t", "x", "y"]);
    var rings = finiteKeys(plan.rings, ["t", "x", "y"]);
    var style = plan.style;
    var cameraIndex = 0;
    var cursorIndex = 0;

    function sourceTime(T) {
      if (!segments.length) return T;
      for (var i = 0; i < segments.length; i += 1) {
        var segment = segments[i];
        if (T < segment.outputStart) return i === 0 ? segment.sourceStart : segments[i - 1].sourceEnd;
        var last = i === segments.length - 1;
        if (T < segment.outputEnd || (last && T <= segment.outputEnd)) {
          var span = segment.outputEnd - segment.outputStart;
          var speed = span > 0 ? (segment.sourceEnd - segment.sourceStart) / span : 0;
          return segment.sourceStart + (T - segment.outputStart) * speed;
        }
      }
      return segments[segments.length - 1].sourceEnd;
    }

    function cameraAt(T) {
      if (!camera.length) return { zoom: 1, cx: 0.5, cy: 0.5 };
      if (T <= camera[0].t) return camera[0];
      while (cameraIndex + 1 < camera.length && camera[cameraIndex + 1].t <= T) cameraIndex += 1;
      var a = camera[cameraIndex];
      var b = camera[cameraIndex + 1];
      if (!b || b.t <= a.t) return a;
      var f = (T - a.t) / (b.t - a.t);
      return { zoom: a.zoom + (b.zoom - a.zoom) * f, cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f };
    }

    function cursorAt(T) {
      if (!cursor.length || T < cursor[0].t) return null;
      while (cursorIndex + 1 < cursor.length && cursor[cursorIndex + 1].t <= T) cursorIndex += 1;
      var a = cursor[cursorIndex];
      if (!a.visible) return null;
      var b = cursor[cursorIndex + 1];
      if (b && b.visible && b.t > a.t) {
        var f = (T - a.t) / (b.t - a.t);
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
      return { x: a.x, y: a.y };
    }

    var FONT = "system-ui, -apple-system, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif";

    function roundedRect(ctx, x, y, w, h, r) {
      var radius = Math.max(0, Math.min(r, w / 2, h / 2));
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.arcTo(x + w, y, x + w, y + radius, radius);
      ctx.lineTo(x + w, y + h - radius);
      ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
      ctx.lineTo(x + radius, y + h);
      ctx.arcTo(x, y + h, x, y + h - radius, radius);
      ctx.lineTo(x, y + radius);
      ctx.arcTo(x, y, x + radius, y, radius);
      ctx.closePath();
    }

    function ellipsize(ctx, text, maxWidth) {
      if (ctx.measureText(text).width <= maxWidth) return text;
      var cut = text;
      while (cut.length > 1 && ctx.measureText(cut + "\u2026").width > maxWidth) cut = cut.slice(0, -1);
      return cut.replace(/\s+$/, "") + "\u2026";
    }

    /** Word-wrapped to at most two lines; what does not fit ends in an ellipsis. */
    function wrap(ctx, text, maxWidth) {
      var words = String(text).split(/\s+/).filter(Boolean);
      var lines = [];
      var line = "";
      for (var i = 0; i < words.length; i += 1) {
        var candidate = line ? line + " " + words[i] : words[i];
        if (!line || ctx.measureText(candidate).width <= maxWidth) {
          line = candidate;
        } else {
          lines.push(line);
          line = words[i];
        }
      }
      if (line) lines.push(line);
      if (lines.length > 2) lines = [lines[0], lines.slice(1).join(" ")];
      return lines.map(function (entry) { return ellipsize(ctx, entry, maxWidth); });
    }

    function drawCaption(ctx, W, H, S, text, alpha) {
      var fontSize = style.captionFontSize * S;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = "600 " + fontSize + "px " + FONT;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      var padX = 0.9 * fontSize;
      var padY = 0.5 * fontSize;
      var bar = 0.2 * fontSize;
      var lineHeight = 1.25 * fontSize;
      // The accent bar sits inside the left padding, as in ade-media.
      var maxText = 0.8 * W - 2 * padX;
      var lines = wrap(ctx, text, Math.max(fontSize, maxText));
      var textWidth = 0;
      for (var i = 0; i < lines.length; i += 1) textWidth = Math.max(textWidth, ctx.measureText(lines[i]).width);
      var boxW = textWidth + 2 * padX;
      var boxH = lines.length * lineHeight + 2 * padY;
      var boxX = (W - boxW) / 2;
      var boxY = H - style.captionMargin * S - boxH;
      var radius = 0.4 * fontSize;
      roundedRect(ctx, boxX, boxY, boxW, boxH, radius);
      ctx.fillStyle = "rgba(17,17,17,0.78)";
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = style.accent;
      ctx.fillRect(boxX, boxY, bar, boxH);
      ctx.restore();
      ctx.fillStyle = "#FFFFFF";
      // One line sits at the left padding; two are each centred in the box.
      var textLeft = boxX + padX;
      for (var j = 0; j < lines.length; j += 1) {
        var lineX = lines.length > 1 ? textLeft + (textWidth - ctx.measureText(lines[j]).width) / 2 : textLeft;
        ctx.fillText(lines[j], lineX, boxY + padY + lineHeight * (j + 0.5));
      }
      ctx.restore();
    }

    function drawBadge(ctx, W, S, text) {
      var fontSize = style.badgeFontSize * S;
      ctx.save();
      ctx.font = "700 " + fontSize + "px " + FONT;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      var padX = 0.5 * fontSize;
      var padY = 0.25 * fontSize;
      var inset = 0.8 * fontSize;
      text = ellipsize(ctx, text, 0.5 * W);
      var textWidth = ctx.measureText(text).width;
      var boxW = textWidth + 2 * padX;
      var boxH = 1.25 * fontSize + 2 * padY;
      var boxX = W - inset - boxW;
      var boxY = inset;
      roundedRect(ctx, boxX, boxY, boxW, boxH, 0.35 * fontSize);
      ctx.fillStyle = "rgba(17,17,17,0.72)";
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(text, boxX + padX, boxY + boxH / 2);
      ctx.restore();
    }

    function drawPointer(ctx, x, y, S) {
      var h = style.pointerHeight * S;
      var polygon = ${JSON.stringify(DEMO_POINTER_POLYGON)};
      ctx.save();
      ctx.beginPath();
      for (var i = 0; i < polygon.length; i += 1) {
        var px = x + polygon[i][0] * h;
        var py = y + polygon[i][1] * h;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = "#FFFFFF";
      ctx.fill();
      ctx.lineJoin = "round";
      ctx.lineWidth = 0.06 * h;
      ctx.strokeStyle = "#111111";
      ctx.stroke();
      ctx.restore();
    }

    function draw(ctx, W, H, image, T) {
      var S = Math.min(W, H);
      var size = sizeOf(image);
      var cam = cameraAt(T);
      var zoom = Math.max(1, cam.zoom || 1);
      var vw = size.width / zoom;
      var vh = size.height / zoom;
      var x0 = clamp(cam.cx * size.width - vw / 2, 0, Math.max(0, size.width - vw));
      var y0 = clamp(cam.cy * size.height - vh / 2, 0, Math.max(0, size.height - vh));
      var scale = Math.min(W / vw, H / vh);
      var dw = vw * scale;
      var dh = vh * scale;
      var dx = (W - dw) / 2;
      var dy = (H - dh) / 2;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, x0, y0, vw, vh, dx, dy, dw, dh);
      function map(nx, ny) {
        return [dx + (nx * size.width - x0) * scale, dy + (ny * size.height - y0) * scale];
      }

      for (var r = 0; r < rings.length; r += 1) {
        var ring = rings[r];
        var age = T - ring.t;
        if (age < 0 || age >= style.ringDurationSeconds) continue;
        var p = clamp(age / style.ringDurationSeconds, 0, 1);
        var e = 1 - (1 - p) * (1 - p);
        var radius = (style.ringStartRadius + (style.ringEndRadius - style.ringStartRadius) * e) * S;
        var at = map(ring.x, ring.y);
        ctx.save();
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = style.accent;
        ctx.lineWidth = style.ringLineWidth * S;
        ctx.beginPath();
        ctx.arc(at[0], at[1], Math.max(0, radius), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      var pointer = cursorAt(T);
      if (pointer) {
        var tip = map(pointer.x, pointer.y);
        drawPointer(ctx, tip[0], tip[1], S);
      }

      var badge = latestShowing(plan.badges || [], T);
      if (badge) drawBadge(ctx, W, S, badge.text);

      var caption = latestShowing(plan.captions || [], T);
      if (caption) {
        // A short fade at each end, never longer than half the caption (as ade-media).
        var fade = Math.min(0.15, (caption.end - caption.start) / 2);
        var alpha = fade > 0 ? clamp(Math.min(1, (T - caption.start) / fade, (caption.end - T) / fade), 0, 1) : 1;
        if (alpha > 0) drawCaption(ctx, W, H, S, caption.text, alpha);
      }
    }

    return { sourceTime: sourceTime, draw: draw };
  }

  function avcCodecs(width, height, fps) {
    var macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
    var rate = macroblocks * fps;
    var level = macroblocks <= 8704 && rate <= 522240 ? "2a" : macroblocks <= 36864 && rate <= 983040 ? "33" : "34";
    return ["avc1.6400" + level, "avc1.4d00" + level, "avc1.4200" + level];
  }

  async function pickEncoderConfig(output) {
    var codecs = avcCodecs(output.width, output.height, output.fps);
    for (var i = 0; i < codecs.length; i += 1) {
      var config = {
        codec: codecs[i],
        width: output.width,
        height: output.height,
        bitrate: output.bitrate,
        framerate: output.fps,
        bitrateMode: "variable",
        latencyMode: "quality",
        hardwareAcceleration: "no-preference",
        avc: { format: "avc" },
      };
      try {
        var support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) return config;
      } catch (error) {
        // An unknown profile string throws on some builds; try the next one.
      }
    }
    throw new Error("This machine's Chromium cannot encode H.264 at " + output.width + "x" + output.height + ".");
  }

  async function render(job) {
    var plan = job.plan;
    var output = plan.output;
    var W = output.width;
    var H = output.height;
    var fps = output.fps;
    var total = Math.max(1, Math.ceil(plan.durationSeconds * fps - 1e-6));
    var frameDuration = Math.round(1e6 / fps);
    var keyEvery = Math.max(1, Math.round((output.keyframeIntervalSeconds || 2) * fps));
    var config = await pickEncoderConfig(output);
    var encodeError = null;
    var dequeueWaiter = null;
    var encoder = new VideoEncoder({
      output: function (chunk, meta) {
        var data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        var item = {
          type: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration == null ? frameDuration : chunk.duration,
          data: data,
        };
        if (meta && meta.decoderConfig) {
          var dc = meta.decoderConfig;
          item.decoderConfig = {
            codec: dc.codec,
            codedWidth: dc.codedWidth,
            codedHeight: dc.codedHeight,
            description: dc.description ? new Uint8Array(ArrayBuffer.isView(dc.description) ? dc.description.buffer.slice(dc.description.byteOffset, dc.description.byteOffset + dc.description.byteLength) : dc.description.slice(0)) : undefined,
          };
        }
        send(item, data.byteLength);
      },
      error: function (error) {
        encodeError = error;
        if (dequeueWaiter) dequeueWaiter();
      },
    });
    encoder.configure(config);
    encoder.addEventListener("dequeue", function () {
      var waiter = dequeueWaiter;
      dequeueWaiter = null;
      if (waiter) waiter();
    });
    var canvas = new OffscreenCanvas(W, H);
    var ctx = canvas.getContext("2d", { alpha: false });
    var renderer = createRender(plan);
    var frames = openFrames(job.rawUrl, null);
    var current = null;
    var upcoming = null;
    try {
      upcoming = await frames.next();
      if (!upcoming) throw new Error("The recording has no frames.");
      for (var n = 0; n < total; n += 1) {
        checkCancelled();
        if (encodeError) throw new Error("H.264 encoding failed: " + (encodeError.message || encodeError));
        var T = n / fps;
        var s = renderer.sourceTime(T);
        while (upcoming && (!current || upcoming.t <= s)) {
          if (current) current.close();
          current = upcoming;
          upcoming = await frames.next();
        }
        renderer.draw(ctx, W, H, await current.image(), T);
        var frame = new VideoFrame(canvas, { timestamp: n * frameDuration, duration: frameDuration });
        try {
          encoder.encode(frame, { keyFrame: n % keyEvery === 0 });
        } finally {
          frame.close();
        }
        while (encoder.encodeQueueSize > 2 && !encodeError && !state.cancelled) {
          await new Promise(function (resolve) { dequeueWaiter = resolve; });
        }
        await waitForSpace();
        state.progress = Math.min(0.999, (n + 1) / total);
      }
      await encoder.flush();
      if (encodeError) throw new Error("H.264 encoding failed: " + (encodeError.message || encodeError));
    } finally {
      if (current) current.close();
      if (upcoming) upcoming.close();
      frames.close();
      if (encoder.state !== "closed") {
        try { encoder.close(); } catch (error) { /* already closed */ }
      }
    }
    state.result = { frames: total, durationSeconds: total / fps, codec: config.codec };
    state.progress = 1;
  }

  window.__adeDemoEngine = {
    start(job) {
      var run = job.mode === "analyze" ? analyze : render;
      run(job).then(function () {
        state.done = true;
        wake();
      }, function (error) {
        fail(error);
      });
      return true;
    },
    next() {
      return new Promise(function (resolve) {
        var answered = false;
        var answer = function () {
          if (answered) return;
          answered = true;
          var chunks = state.outbox.splice(0);
          state.outBytes = 0;
          var waiters = state.spaceWaiters.splice(0);
          for (var i = 0; i < waiters.length; i += 1) waiters[i]();
          resolve({
            progress: state.progress,
            chunks: chunks,
            done: state.done,
            result: state.done ? state.result : null,
            error: state.error,
          });
        };
        if (state.outbox.length || state.done || state.error) {
          answer();
          return;
        }
        state.waiter = answer;
        setTimeout(function () {
          if (state.waiter === answer) state.waiter = null;
          answer();
        }, 1000);
      });
    },
    cancel() {
      state.cancelled = true;
      fail(new Error("cancelled"));
      return true;
    },
  };
  return true;
})()
`;

type EngineChunk = {
  type: "key" | "delta";
  timestamp: number;
  duration: number;
  data: Uint8Array;
  decoderConfig?: { codec: string; codedWidth?: number; codedHeight?: number; description?: Uint8Array };
};

type EngineAnswer = {
  progress: number;
  chunks: EngineChunk[];
  done: boolean;
  result: unknown;
  error: string | null;
};

type EngineJob =
  | { mode: "analyze"; input: string }
  | { mode: "render"; input: string; plan: DemoPlan };

class EngineJobError extends Error {}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new EngineJobError(message)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function renameIntoPlace(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows: a player or a virus scanner holding the old file refuses the
      // replace for a moment.
      const sharing = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!sharing || attempt >= RENAME_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

/**
 * Where the job's page and raw file are served from; one token per job. The
 * job's open read streams are closed when it ends: on Windows an open handle
 * would stop the raw file from being deleted afterwards.
 *
 * An H.264 MP4 input (the Windows desktop driver's recording) is served as
 * `.aderaw` records made from its samples on the fly (`demoMp4Source.ts`), so
 * the page reads one format.
 */
type ServedJob = { input: string; mp4: DemoMp4Info | null; streams: Set<Readable> };

/** True for an input this engine reads: an `.aderaw` capture or an H.264 MP4. */
function readsInput(inputPath: string): boolean {
  return path.extname(inputPath).toLowerCase() === DEMO_RAW_FILE_EXTENSION || isDemoMp4Path(inputPath);
}

export type ChromiumDemoEngine = DemoEngine & { dispose(): void };

export function createChromiumDemoEngine(deps: { logger: Logger }): ChromiumDemoEngine {
  const { logger } = deps;
  const served = new Map<string, ServedJob>();
  let handlerInstalled = false;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  /** Fails the running job; set while one runs. */
  let failActive: ((error: Error) => void) | null = null;

  const engineSession = (): Electron.Session => {
    const ses = electronSession.fromPartition(PARTITION);
    if (!handlerInstalled) {
      handlerInstalled = true;
      // The partition is this engine's alone, so every https request in it is
      // one of ours: a job page or its raw file. Anything else is refused, so
      // nothing in the page can reach the network.
      ses.protocol.handle("https", (request) => {
        let url: URL;
        try {
          url = new URL(request.url);
        } catch {
          return new Response("Not found", { status: 404 });
        }
        const [token, resource = ""] = url.pathname.replace(/^\/+/, "").split("/");
        const job = url.hostname === ORIGIN_HOST && token ? served.get(token) : undefined;
        if (!job || request.method !== "GET") return new Response("Not found", { status: 404 });
        if (resource === "") {
          return new Response("<!doctype html><meta charset=utf-8><title>ADE demo engine</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (resource === "raw") {
          const stream: Readable = job.mp4
            ? demoRawStreamFromMp4(job.input, job.mp4)
            : fs.createReadStream(job.input, { highWaterMark: 1024 * 1024 });
          job.streams.add(stream);
          stream.once("close", () => job.streams.delete(stream));
          return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        return new Response("Not found", { status: 404 });
      });
    }
    return ses;
  };

  const runJob = async (
    job: EngineJob,
    options: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
    onChunk: ((chunk: EngineChunk) => void) | null,
  ): Promise<unknown> => {
    if (disposed) throw new Error("The Chromium demo engine was shut down.");
    if (options.signal?.aborted) throw new Error("The demo render was cancelled.");
    // An MP4's index is read here, so a file that is not a finished H.264
    // movie fails with its reason before any window opens.
    const mp4 = isDemoMp4Path(job.input) ? await readDemoMp4(job.input) : null;
    if (!mp4 && !(await hasDemoRawMagic(job.input))) {
      throw new Error(`The recording ${path.basename(job.input)} is missing or is not an ADE raw capture.`);
    }
    if (mp4 && !mp4.frames) throw new Error("The recording has no frames.");
    const size = (await fs.promises.stat(job.input)).size;
    const token = randomBytes(18).toString("base64url");
    const servedJob: ServedJob = { input: job.input, mp4, streams: new Set() };
    served.set(token, servedJob);
    engineSession();
    const window = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      skipTaskbar: true,
      webPreferences: {
        partition: PARTITION,
        // Hidden and must keep its timers and codecs running.
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    let failure: Error | null = null;
    let rejectFailure: ((error: Error) => void) | null = null;
    const failed = new Promise<never>((_, reject) => {
      rejectFailure = reject;
    });
    failed.catch(() => {});
    const fail = (error: Error): void => {
      if (failure) return;
      failure = error;
      rejectFailure?.(error);
    };
    failActive = fail;
    const onAbort = (): void => fail(new Error("The demo render was cancelled."));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    window.webContents.on("render-process-gone", (_event, details) => {
      fail(new Error(`The demo renderer stopped (${details.reason}).`));
    });
    const jobTimer = setTimeout(() => fail(new Error("The demo render took longer than 30 minutes and was stopped.")), JOB_TIMEOUT_MS);
    const guarded = <T,>(promise: Promise<T>): Promise<T> => Promise.race([promise, failed]);
    const exec = <T,>(source: string): Promise<T> =>
      guarded(window.webContents.executeJavaScript(source, true) as Promise<T>);
    const startedAt = Date.now();
    try {
      await guarded(withTimeout(window.loadURL(`https://${ORIGIN_HOST}/${token}/`), SETUP_TIMEOUT_MS, "The demo renderer did not load."));
      await withTimeout(exec(ENGINE_SOURCE), SETUP_TIMEOUT_MS, "The demo renderer did not start.");
      const request = job.mode === "analyze"
        ? {
          mode: "analyze",
          rawUrl: `https://${ORIGIN_HOST}/${token}/raw`,
          size,
          thumbnailLongSide: DEMO_ANALYSIS_THUMBNAIL_LONG_SIDE,
          pixelDelta: DEMO_ANALYSIS_PIXEL_DELTA,
          minInterval: DEMO_ANALYSIS_MIN_INTERVAL_SECONDS,
        }
        : { mode: "render", rawUrl: `https://${ORIGIN_HOST}/${token}/raw`, plan: job.plan };
      await withTimeout(exec(`window.__adeDemoEngine.start(${JSON.stringify(request)})`), SETUP_TIMEOUT_MS, "The demo renderer did not start.");
      let lastProgress = -1;
      let lastMovedAt = Date.now();
      for (;;) {
        const answer = await withTimeout(
          exec<EngineAnswer>("window.__adeDemoEngine.next()"),
          STALL_TIMEOUT_MS,
          "The demo renderer stopped answering.",
        );
        if (answer.error) {
          throw new Error(answer.error === "cancelled" ? "The demo render was cancelled." : answer.error);
        }
        for (const chunk of answer.chunks ?? []) onChunk?.(chunk);
        if (answer.progress !== lastProgress || answer.chunks?.length) {
          lastProgress = answer.progress;
          lastMovedAt = Date.now();
          options.onProgress?.(Math.max(0, Math.min(1, answer.progress)));
        } else if (Date.now() - lastMovedAt > STALL_TIMEOUT_MS) {
          throw new Error("The demo render stalled: no progress for a minute.");
        }
        if (answer.done) {
          logger.info("demo_video.chromium_job_done", { mode: job.mode, elapsedMs: Date.now() - startedAt, bytes: size });
          return answer.result;
        }
      }
    } catch (error) {
      const message = failure ? failure.message : describe(error);
      logger.warn("demo_video.chromium_job_failed", { mode: job.mode, error: message, elapsedMs: Date.now() - startedAt });
      throw new Error(message);
    } finally {
      clearTimeout(jobTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failActive === fail) failActive = null;
      served.delete(token);
      if (!window.isDestroyed()) window.destroy();
      for (const stream of servedJob.streams) stream.destroy();
      servedJob.streams.clear();
    }
  };

  /** One job at a time: a queued job starts when the one before it settles. */
  const enqueue = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const analyze = (inputPath: string, options: { signal?: AbortSignal } = {}): Promise<DemoAnalysis> =>
    enqueue(async () => {
      const result = await runJob({ mode: "analyze", input: inputPath }, options, null) as DemoAnalysis;
      if (!result || !Array.isArray(result.frames) || !result.frames.length) {
        throw new Error("The demo engine measured no frames in the recording.");
      }
      return result;
    });

  const render = (
    request: DemoRenderRequest,
    options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
  ): Promise<DemoRenderResult> =>
    enqueue(async () => {
      const { plan } = request;
      if (!plan || !plan.output || !Array.isArray(plan.segments)) throw new Error("The demo render needs a plan with an output and segments.");
      const output = plan.output;
      if (!(output.width > 0 && output.height > 0 && output.width % 2 === 0 && output.height % 2 === 0)) {
        throw new Error(`The demo plan's output size ${output.width}x${output.height} is not a positive even size.`);
      }
      if (!(output.fps > 0) || !(output.bitrate > 0)) throw new Error("The demo plan's frame rate or bitrate is not positive.");
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: "avc", width: output.width, height: output.height, frameRate: output.fps },
        fastStart: "in-memory",
        firstTimestampBehavior: "offset",
      });
      let chunks = 0;
      const result = await runJob({ mode: "render", input: request.input, plan }, options, (chunk) => {
        const meta = chunk.decoderConfig
          ? { decoderConfig: { ...chunk.decoderConfig, description: chunk.decoderConfig.description ?? undefined } }
          : undefined;
        muxer.addVideoChunkRaw(
          new Uint8Array(chunk.data),
          chunk.type,
          chunk.timestamp,
          chunk.duration,
          meta as Parameters<typeof muxer.addVideoChunkRaw>[4],
        );
        chunks += 1;
      }) as { frames: number; durationSeconds: number };
      if (!chunks) throw new Error("The demo render produced no video.");
      muxer.finalize();
      const bytes = Buffer.from(muxer.target.buffer);
      await fs.promises.mkdir(path.dirname(request.output), { recursive: true });
      const temp = `${request.output}.${randomBytes(6).toString("hex")}.part`;
      try {
        await fs.promises.writeFile(temp, bytes);
        await renameIntoPlace(temp, request.output);
      } catch (error) {
        await fs.promises.rm(temp, { force: true }).catch(() => {});
        throw new Error(`The demo video could not be written: ${describe(error)}`);
      }
      return { bytes: bytes.length, durationSeconds: result.durationSeconds, frames: result.frames };
    });

  return {
    id: "chromium",
    canRead: readsInput,
    analyze,
    render,
    dispose() {
      disposed = true;
      failActive?.(new Error("The Chromium demo engine was shut down."));
    },
  };
}
