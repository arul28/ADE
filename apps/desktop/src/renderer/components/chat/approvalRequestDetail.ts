import type { PendingInputRequest } from "../../../shared/types";

/**
 * The thing an approval is actually about, pulled out of the request.
 *
 * The card's prose comes from the provider and is not always specific: an ADE
 * policy that decides "ask" supplies its own reason, and that reason replaces
 * the "Run command: …" headline the runtime would otherwise have built. The
 * result was a card reading only "This command requires approval" — the one
 * question it exists to answer ("which command?") left unanswered, while the
 * command sat in `providerMetadata.input` all along.
 *
 * Providers agree on `input`/`toolInput` carrying the tool's arguments, so this
 * reads whichever is present and returns the one field worth showing verbatim.
 * Returns null when there is nothing better than the prose — never a guess.
 */
export type ApprovalRequestDetail = {
  /** Monospace body: a shell command, or the path a file tool would touch. */
  text: string;
  /** What the text IS, for the card's little caption. */
  kind: "command" | "path";
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function approvalRequestDetail(
  request: Pick<PendingInputRequest, "providerMetadata"> | null | undefined,
): ApprovalRequestDetail | null {
  const metadata = asRecord(request?.providerMetadata);
  if (!metadata) return null;
  const input = asRecord(metadata.input) ?? asRecord(metadata.toolInput);
  if (!input) return null;
  const command = nonEmptyString(input.command) ?? nonEmptyString(input.cmd);
  if (command) return { text: command, kind: "command" };
  const path = nonEmptyString(input.file_path)
    ?? nonEmptyString(input.filePath)
    ?? nonEmptyString(metadata.blockedPath);
  if (path) return { text: path, kind: "path" };
  return null;
}

/**
 * True when the prose already contains the detail verbatim — in which case
 * repeating it below would just be the same string twice in one card.
 */
export function approvalDetailIsRedundant(
  detail: ApprovalRequestDetail | null,
  description: string | null | undefined,
): boolean {
  if (!detail) return true;
  if (!description) return false;
  return description.includes(detail.text);
}
