/** ADE's own items: the parts of the prompt ADE builds, each counted from its exact text. */

import type { ProviderContextItem } from "../../../../shared/types/providerContext";
import type { AdeChatContextPart, AdeChatContextPreview } from "../../chat/adeChatContextPreview";
import { located, type Ctx } from "./fsScan";
import { estimateTextTokens } from "./items";

export function adeItems(ctx: Ctx, preview: AdeChatContextPreview): ProviderContextItem[] {
  const byId = new Map(preview.parts.map((part) => [part.id, part]));
  const toItem = (part: AdeChatContextPart, tokens: number, label = part.label, detail = part.detail ?? null): ProviderContextItem => ({
    id: part.id,
    owner: "ade",
    kind: part.kind,
    label,
    source: part.source ?? null,
    ...(part.id === "ade-project-notes" ? { setIn: "ADE Settings › Agent notes", settingsEntry: "project-agents.agent-notes" } : {}),
    tokens,
    sizeKind: "exact",
    timing: part.timing,
    detail,
    ...(part.entries?.length
      ? {
          children: part.entries.map((entry, index) => ({
            id: `${part.id}-${index}`,
            owner: "ade" as const,
            kind: "skill" as const,
            label: entry.name,
            ...(entry.source ? located(ctx, entry.source) : { source: null }),
            tokens: estimateTextTokens(entry.text),
            sizeKind: "exact" as const,
            timing: part.timing,
          })),
        }
      : {}),
  });
  const items: ProviderContextItem[] = [];
  for (const part of preview.parts) {
    if (part.id === "ade-prompt") {
      const inner = (part.includes ?? []).map((id) => byId.get(id)).filter((entry): entry is AdeChatContextPart => Boolean(entry));
      const rest = Math.max(0, estimateTextTokens(part.text) - inner.reduce((total, entry) => total + estimateTextTokens(entry.text), 0));
      // ACP guidance is just the CLI guidance and notes; nothing of its own is left.
      if (rest < 20 && inner.length) continue;
      items.push(toItem(part, rest, inner.length ? `${part.label} (the rest)` : part.label,
        inner.length ? `${part.detail ?? ""} The parts listed beside it are counted on their own.`.trim() : part.detail ?? null));
      continue;
    }
    items.push(toItem(part, estimateTextTokens(part.text)));
  }
  return items;
}
