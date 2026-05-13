import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { AgentChatEventEnvelope, AgentChatFileRef } from "../../../desktop/src/shared/types/chat";

const IMAGE_FILE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|heic|heif|avif)$/i;
const CLIPBOARD_MAX_BUFFER = 120 * 1024 * 1024;
let clipboardTargetCounter = 0;

export type ImageDimensions = {
  width: number;
  height: number;
};

export function isImageFilePath(filePath: string): boolean {
  return IMAGE_FILE_EXTENSION_RE.test(filePath);
}

export function normalizeOpenableImageTarget(rawTarget: string): string | null {
  const target = rawTarget.trim();
  if (!target || /^data:/i.test(target)) return null;
  if (isHttpUrl(target)) return target;
  if (!path.isAbsolute(target)) return null;
  if (!isImageFilePath(target)) return null;
  return target;
}

export function latestOpenableImageTarget(events: AgentChatEventEnvelope[]): string | null {
  const acceptTarget = (candidate: unknown): string | null => (
    typeof candidate === "string" ? normalizeOpenableImageTarget(candidate) : null
  );

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event as Record<string, unknown> | undefined;
    if (!event) continue;
    if (event.type === "codex_image_generation") {
      const savedPath = acceptTarget(event.savedPath);
      if (savedPath) return savedPath;
      const result = acceptTarget(event.result);
      if (result) return result;
    }
    if (event.type === "codex_image_view") {
      const local = acceptTarget(event.path);
      if (local) return local;
      const remote = acceptTarget(event.url);
      if (remote) return remote;
    }
  }

  return null;
}

export function readImageDimensions(filePath: string): ImageDimensions | null {
  try {
    const buffer = fs.readFileSync(filePath);
    return readImageDimensionsFromBuffer(buffer);
  } catch {
    return null;
  }
}

export function readClipboardImageAttachment(workspaceRoot: string): AgentChatFileRef | null {
  if (process.platform === "darwin") {
    const pngpasteAttachment = readMacClipboardWithPngpaste(workspaceRoot);
    if (pngpasteAttachment) return pngpasteAttachment;

    const applescriptAttachment = readMacClipboardWithAppleScript(workspaceRoot);
    if (applescriptAttachment) return applescriptAttachment;

    const pbpasteAttachment = readMacClipboardWithPbpaste(workspaceRoot);
    if (pbpasteAttachment) return pbpasteAttachment;

    const filePath = readMacClipboardFilePath();
    if (filePath) return { path: filePath, type: "image" };
  }

  if (process.platform === "win32" && commandAvailable("powershell")) {
    const target = clipboardImageTarget(workspaceRoot);
    const command = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "Add-Type -AssemblyName System.Drawing;",
      "$image = [System.Windows.Forms.Clipboard]::GetImage();",
      `if ($image -ne $null) { $image.Save(${powershellQuoted(target)}, [System.Drawing.Imaging.ImageFormat]::Png) }`,
    ].join(" ");
    const result = spawnSync("powershell", ["-NoProfile", "-Command", command], { stdio: "ignore" });
    if (result.status === 0 && nonEmptyFile(target)) return { path: target, type: "image" };
  }

  if (process.platform === "linux") {
    const target = clipboardImageTarget(workspaceRoot);
    const commands: string[][] = commandAvailable("wl-paste")
      ? [["wl-paste", "-t", "image/png"]]
      : commandAvailable("xclip")
        ? [["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]]
        : [];
    for (const [command, ...args] of commands) {
      const result = spawnSync(command, args, { encoding: "buffer", maxBuffer: 30 * 1024 * 1024 });
      if (result.status === 0 && result.stdout.length) {
        fs.writeFileSync(target, result.stdout);
        if (nonEmptyFile(target)) return { path: target, type: "image" };
      }
    }
  }

  const clipboardPath = readClipboardTextPaths().find((candidate) => fs.existsSync(candidate) && isImageFilePath(candidate));
  if (clipboardPath) return { path: clipboardPath, type: "image" };
  return null;
}

export function parseAppleScriptClipboardData(stdout: string | Buffer): Buffer | null {
  const text = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout;
  const match = text.match(/data\s+[A-Za-z0-9]{4}\s*([0-9A-Fa-f\s]+)>|«data\s+[A-Za-z0-9]{4}\s*([0-9A-Fa-f\s]+)»/);
  const hex = (match?.[1] ?? match?.[2] ?? "").replace(/\s+/g, "");
  if (!hex || hex.length % 2 !== 0) return null;
  return Buffer.from(hex, "hex");
}

export function readImageDimensionsFromBuffer(buffer: Buffer): ImageDimensions | null {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return readWebpDimensions(buffer);
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return readJpegDimensions(buffer);
  }
  return null;
}

function isHttpUrl(target: string): boolean {
  try {
    const parsed = new URL(target);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    shell: process.platform !== "win32",
    stdio: "ignore",
  });
  return result.status === 0;
}

function clipboardImageTarget(workspaceRoot: string, extension = "png"): string {
  const dir = path.join(workspaceRoot, ".ade", "cache", "ade-code-clipboard");
  fs.mkdirSync(dir, { recursive: true });
  clipboardTargetCounter += 1;
  return path.join(dir, `pasted-screenshot-${Date.now()}-${clipboardTargetCounter}.${extension}`);
}

function powershellQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function nonEmptyFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function readClipboardText(): string | null {
  const candidates = process.platform === "darwin"
    ? [["pbpaste"]]
    : process.platform === "win32"
      ? [["powershell", "-NoProfile", "-Command", "Get-Clipboard"]]
      : [["wl-paste", "--no-newline"], ["xclip", "-selection", "clipboard", "-o"]];
  for (const [command, ...args] of candidates) {
    if (!commandAvailable(command)) continue;
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return null;
}

function readClipboardTextPaths(): string[] {
  return (readClipboardText() ?? "")
    .split(/\r?\n/)
    .map((line) => normalizeClipboardPathText(line))
    .filter((line): line is string => Boolean(line));
}

function normalizeClipboardPathText(value: string): string | null {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return null;
  if (/^file:/i.test(trimmed)) {
    try {
      return decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      return null;
    }
  }
  return trimmed;
}

function readMacClipboardWithPngpaste(workspaceRoot: string): AgentChatFileRef | null {
  if (!commandAvailable("pngpaste")) return null;
  const target = clipboardImageTarget(workspaceRoot);
  const result = spawnSync("pngpaste", [target], { stdio: "ignore" });
  return result.status === 0 && nonEmptyFile(target) ? { path: target, type: "image" } : null;
}

function readMacClipboardWithPbpaste(workspaceRoot: string): AgentChatFileRef | null {
  if (!commandAvailable("pbpaste")) return null;
  const result = spawnSync("pbpaste", ["-Prefer", "image"], { encoding: "buffer", maxBuffer: 30 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout.length) return null;
  return writeClipboardImageBuffer(workspaceRoot, result.stdout);
}

function readMacClipboardWithAppleScript(workspaceRoot: string): AgentChatFileRef | null {
  if (!commandAvailable("osascript")) return null;
  for (const clipboardClass of ["PNGf", "TIFF"]) {
    const result = spawnSync("osascript", ["-e", `try`, "-e", `the clipboard as «class ${clipboardClass}»`, "-e", "end try"], {
      encoding: "utf8",
      maxBuffer: CLIPBOARD_MAX_BUFFER,
    });
    if (result.status !== 0 || !result.stdout) continue;
    const buffer = parseAppleScriptClipboardData(result.stdout);
    if (!buffer?.length) continue;
    const attachment = writeClipboardImageBuffer(workspaceRoot, buffer, clipboardClass === "TIFF" ? "tiff" : "png");
    if (attachment) return attachment;
  }
  return null;
}

function readMacClipboardFilePath(): string | null {
  if (!commandAvailable("osascript")) return null;
  const script = [
    "use framework \"Foundation\"",
    "use framework \"AppKit\"",
    "set pasteboard to current application's NSPasteboard's generalPasteboard()",
    "set urls to pasteboard's readObjectsForClasses:{current application's NSURL} options:{NSPasteboardURLReadingFileURLsOnlyKey:true}",
    "set paths to {}",
    "repeat with itemUrl in urls",
    "set end of paths to (itemUrl's |path|()) as text",
    "end repeat",
    "return paths",
  ];
  const result = spawnSync("osascript", script.flatMap((line) => ["-e", line]), { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout
    .split(/,\s*|\r?\n/)
    .map((line) => normalizeClipboardPathText(line))
    .find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate) && isImageFilePath(candidate))) ?? null;
}

function writeClipboardImageBuffer(workspaceRoot: string, buffer: Buffer, preferredExtension = imageExtensionForBuffer(buffer)): AgentChatFileRef | null {
  if (!preferredExtension) return null;
  if (preferredExtension === "tiff" || preferredExtension === "tif") {
    return writeConvertedTiffClipboardImage(workspaceRoot, buffer);
  }
  const target = clipboardImageTarget(workspaceRoot, preferredExtension);
  fs.writeFileSync(target, buffer);
  return nonEmptyFile(target) ? { path: target, type: "image" } : null;
}

function writeConvertedTiffClipboardImage(workspaceRoot: string, buffer: Buffer): AgentChatFileRef | null {
  if (!commandAvailable("sips")) return null;
  const source = clipboardImageTarget(workspaceRoot, "tiff");
  const target = clipboardImageTarget(workspaceRoot, "png");
  fs.writeFileSync(source, buffer);
  const result = spawnSync("sips", ["-s", "format", "png", source, "--out", target], { stdio: "ignore" });
  try {
    fs.rmSync(source, { force: true });
  } catch {
    // Best-effort cleanup; the converted PNG is the durable attachment.
  }
  return result.status === 0 && nonEmptyFile(target) ? { path: target, type: "image" } : null;
}

function imageExtensionForBuffer(buffer: Buffer): string | null {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") return "gif";
  if (
    buffer.subarray(0, 4).toString("ascii") === "II*\0"
    || buffer.subarray(0, 4).toString("ascii") === "MM\0*"
  ) return "tiff";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | null {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (marker && marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function readWebpDimensions(buffer: Buffer): ImageDimensions | null {
  const chunk = buffer.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25) {
    const b1 = buffer[21]!;
    const b2 = buffer[22]!;
    const b3 = buffer[23]!;
    const b4 = buffer[24]!;
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  return null;
}
