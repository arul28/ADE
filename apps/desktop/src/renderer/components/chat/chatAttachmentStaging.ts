import {
  LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
  attachmentTooLargeMessage,
} from "../../../shared/chatAttachmentLimits";
import type {
  ChatAttachmentStagingMode,
  HeicConversionErrorCode,
} from "../../../shared/types/chat";
import type { OpenProjectBinding } from "../../../shared/types/core";

export type AttachmentStagingPlan =
  /** Send only the path; the bytes never enter the renderer. */
  | { transport: "path"; sourcePath: string; maxBytes: number }
  /** Read the file and send base64 — the legacy image-only command. */
  | { transport: "bytes"; maxBytes: number };

/**
 * How ONE file is staged, given what the destination machine supports.
 *
 * The machine-level answer (`mode`) is necessary but not sufficient: a host may
 * accept a 50 MB streamed upload while this particular file has no path to
 * stream. Three things force the bytes path even on a capable machine:
 *
 * - **No source path.** A clipboard paste is bytes in memory and nothing else.
 *   So is every file in the hosted web client, where `webUtils` does not exist
 *   and `getDroppedPath` returns "". There is no file on disk to point at.
 * - **Conversion.** A HEIC photo is decoded to JPEG in the renderer first, so
 *   what gets staged is a buffer this process produced, not the file the user
 *   picked.
 * - **The host said so.** `mode: "base64"` — a host predating the upload route,
 *   or a relay-routed socket an HTTP POST cannot follow.
 *
 * Whenever the bytes path is taken the cap drops to the legacy ceiling, because
 * that is the contract `chat.saveTempAttachment` actually enforces on the other
 * end. Returning the larger number here would only move the rejection later.
 */
export function planAttachmentStaging(args: {
  mode: ChatAttachmentStagingMode;
  sourcePath: string | null | undefined;
  requiresByteConversion: boolean;
}): AttachmentStagingPlan {
  const sourcePath = args.sourcePath?.trim() ?? "";
  if (
    args.mode.mode === "base64"
    || args.requiresByteConversion
    || !sourcePath
  ) {
    return {
      transport: "bytes",
      maxBytes: Math.min(args.mode.maxBytes, LEGACY_MAX_CHAT_ATTACHMENT_BYTES),
    };
  }
  return { transport: "path", sourcePath, maxBytes: args.mode.maxBytes };
}

/** The rejection a file gets when it exceeds the plan's ceiling. */
export function attachmentPlanRejection(
  plan: AttachmentStagingPlan,
  name: string,
  byteLength: number,
): string | null {
  if (byteLength <= plan.maxBytes) return null;
  return attachmentTooLargeMessage(name, byteLength, plan.maxBytes);
}

/** Fallback used before the machine answers, and if the probe itself fails. */
export const CONSERVATIVE_ATTACHMENT_STAGING_MODE: ChatAttachmentStagingMode = {
  mode: "base64",
  maxBytes: LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
};

/**
 * Ask the machine that owns this chat how it stages attachments. Never throws —
 * a machine that cannot answer gets the conservative legacy contract, which
 * every host has supported since attachments existed.
 */
export async function readAttachmentStagingMode(
  pin: OpenProjectBinding | null | undefined,
): Promise<ChatAttachmentStagingMode> {
  const read = window.ade?.agentChat?.getAttachmentStagingMode;
  if (typeof read !== "function") return CONSERVATIVE_ATTACHMENT_STAGING_MODE;
  try {
    const mode = await read(pin);
    if (!mode || typeof mode.maxBytes !== "number" || !Number.isFinite(mode.maxBytes)) {
      return CONSERVATIVE_ATTACHMENT_STAGING_MODE;
    }
    return mode;
  } catch {
    return CONSERVATIVE_ATTACHMENT_STAGING_MODE;
  }
}

/** What either transport hands back, so the composer's tail is written once. */
export type StagedAttachment = {
  path: string;
  mimeType: string | null;
  /** Set only when the renderer produced the bytes, i.e. a converted HEIC. */
  previewDataUrl: string | null;
};

/**
 * A HEIC the renderer could not hand to the host as JPEG. Distinguished from
 * every other staging failure because the file will fail the same way on every
 * attempt, so the composer offers no retry for it.
 */
export class AttachmentConversionError extends Error {
  constructor(readonly code: HeicConversionErrorCode) {
    super(code);
    this.name = "AttachmentConversionError";
  }
}

// btoa takes a string, and spreading a multi-megabyte Uint8Array into
// String.fromCharCode blows the argument limit, so encode in chunks.
const BASE64_ENCODE_CHUNK_SIZE = 0x8000;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += BASE64_ENCODE_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_ENCODE_CHUNK_SIZE);
    parts.push(String.fromCharCode(...chunk));
  }
  return btoa(parts.join(""));
}

/**
 * The bytes leg of {@link planAttachmentStaging}: read the file in the
 * renderer, convert it first when the host cannot read the format, and hand the
 * base64 to the legacy `saveTempAttachment` command.
 *
 * HEIC is converted here rather than on the host because the file may never
 * reach a host that can decode it — a clipboard paste and the hosted web client
 * both arrive as bytes with no path at all.
 */
export async function stageAttachmentBytesFromFile(args: {
  file: File;
  filename: string;
  requiresHeicConversion: boolean;
  pin: OpenProjectBinding | null | undefined;
}): Promise<StagedAttachment> {
  const buffer = await args.file.arrayBuffer();
  let filename = args.filename;
  let data = arrayBufferToBase64(buffer);
  let mimeType: string | null = args.file.type || null;
  let previewDataUrl: string | null = null;
  if (args.requiresHeicConversion) {
    const convertImageToJpeg = window.ade?.app?.convertImageToJpeg;
    if (typeof convertImageToJpeg !== "function") {
      throw new AttachmentConversionError("unavailable");
    }
    const converted = await convertImageToJpeg({
      data,
      filename: args.filename,
      mimeType: args.file.type || null,
    });
    if (converted.ok !== true) {
      throw new AttachmentConversionError(
        converted.errorCode === "unavailable" ? "unavailable" : "failed",
      );
    }
    filename = converted.filename;
    data = converted.data;
    mimeType = converted.mimeType;
    previewDataUrl = `data:${converted.mimeType};base64,${converted.data}`;
  }
  const { path } = await window.ade.agentChat.saveTempAttachment({ data, filename }, args.pin);
  return { path, mimeType, previewDataUrl };
}
