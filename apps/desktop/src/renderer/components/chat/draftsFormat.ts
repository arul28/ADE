import type { AgentChatFileRef, DraftEntry, DraftStatus } from "../../../shared/types";

/**
 * The draft list's pure presentation helpers: text shaping, relative time, and
 * the one line that states a row's status. Kept out of the panel component so
 * the component is about behaviour and this is about wording.
 */

const DRAFT_SNIPPET_MAX_CHARS = 110;

export function promptSnippet(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= DRAFT_SNIPPET_MAX_CHARS) return normalized;
  return `${normalized.slice(0, DRAFT_SNIPPET_MAX_CHARS)}…`;
}

export function relativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/** "9:00 AM", "9:00 AM tomorrow", or a date once it is further out. */
export function fireTimeLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const fireAt = Date.parse(iso);
  if (!Number.isFinite(fireAt)) return "";
  const when = new Date(fireAt);
  const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(when);
  const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  if (dayKey(when) === dayKey(today)) return clock;
  if (dayKey(when) === dayKey(tomorrow)) return `${clock} tomorrow`;
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(when);
  return `${date}, ${clock}`;
}

export function providerLabel(entry: DraftEntry): string | null {
  const provider = entry.provider?.trim();
  if (!provider) return null;
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function attachmentName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export function sameAttachment(left: AgentChatFileRef, right: AgentChatFileRef): boolean {
  return left.path === right.path
    && left.type === right.type
    && (left.type !== "image-url" || right.type !== "image-url" || left.url === right.url);
}

export function draftAttachments(entry: DraftEntry): AgentChatFileRef[] {
  return entry.attachments ?? [];
}

export function isDraftableAttachment(attachment: AgentChatFileRef): boolean {
  return attachment.type === "image" || attachment.type === "image-url";
}

export function base64FromDataUrl(dataUrl: string): string {
  const separator = dataUrl.indexOf(",");
  if (separator < 0 || !/;base64$/i.test(dataUrl.slice(0, separator))) {
    throw new Error("The attached image could not be prepared for saving.");
  }
  const base64 = dataUrl.slice(separator + 1);
  if (!base64) throw new Error("The attached image is empty.");
  return base64;
}

export function draftEntryLabel(entry: DraftEntry, attachments: AgentChatFileRef[]): string {
  const snippet = promptSnippet(entry.text);
  if (snippet) return snippet;
  if (attachments.length === 1) return attachmentName(attachments[0]!.path);
  const attachmentCount = draftAttachmentCount(entry);
  return attachmentCount === 1 ? "1 image" : `${attachmentCount} images`;
}

export function draftAttachmentCount(entry: DraftEntry): number {
  return entry.attachmentCount ?? draftAttachments(entry).length;
}

export function draftAttachmentsUnavailable(entry: DraftEntry): boolean {
  return entry.attachmentsAvailable === false && draftAttachmentCount(entry) > 0;
}

export function isScheduledEntry(entry: DraftEntry): boolean {
  return entry.kind === "scheduled";
}

/** A send the user has to act on: it could not go out, or it never happened. */
export function needsAttention(entry: DraftEntry): boolean {
  return entry.status === "blocked" || entry.status === "missed";
}

export function isPendingSchedule(entry: DraftEntry): boolean {
  return entry.status === "scheduled" || entry.status === "sending" || entry.status === "blocked";
}

/** What a row says on its second line. Never blank: it is the row's status. */
export function draftMetaLine(entry: DraftEntry): string {
  if (needsAttention(entry)) return entry.lastError?.trim() || "Could not be sent.";
  if (isScheduledEntry(entry)) {
    const status: DraftStatus = entry.status ?? "scheduled";
    if (status === "sent") return `Sent ${relativeTime(entry.firedAt ?? entry.scheduledAt ?? entry.createdAt)}`;
    if (status === "cancelled") return "Cancelled";
    if (status === "sending") return "Sending now…";
    return fireTimeLabel(entry.scheduledAt) || "Scheduled";
  }
  return relativeTime(entry.updatedAt ?? entry.createdAt);
}
