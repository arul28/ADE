export function extractLeadingSlashCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*/);
  return match?.[0]?.toLowerCase() ?? null;
}

export function shouldTreatLeadingSlashInputAsChatText(text: string): boolean {
  const command = extractLeadingSlashCommand(text);
  if (!command) return false;

  const remainder = text.trim().slice(command.length).trim();
  if (!remainder.length) return false;
  if (remainder === "?") return true;

  if (/^(is|are|am|was|were|do|does|did|can|could|should|would|will|what|why|where|when|who|how)\b/i.test(remainder)) {
    return true;
  }

  return /\?\s*$/.test(remainder) && /\b(is|are|do|does|did|can|could|should|would|right)\b/i.test(remainder);
}

export function isProviderSlashCommandInput(text: string): boolean {
  return extractLeadingSlashCommand(text) != null && !shouldTreatLeadingSlashInputAsChatText(text);
}
