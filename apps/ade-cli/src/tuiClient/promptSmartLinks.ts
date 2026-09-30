import {
  chipDisplayLabel,
  chipFromSmartLink,
  chipFromModelMention,
  chipGlyphAscii,
} from "../../../desktop/src/shared/chips";
import { parseModelMentions, type ParsedModelMention } from "../../../desktop/src/shared/modelMentions";
import {
  findSmartLinks,
  type SmartLinkMatch,
} from "../../../desktop/src/shared/smartLinks";

type PromptLinkEdit = { value: string; cursor: number };

export function deletePromptSmartLinkBackward(value: string, cursor: number): PromptLinkEdit | null {
  const link = findSmartLinks(value).find(({ start, end }) => cursor - 1 >= start && cursor - 1 < end);
  return link
    ? { value: `${value.slice(0, link.start)}${value.slice(link.end)}`, cursor: link.start }
    : null;
}

export function deletePromptSmartLinkForward(value: string, cursor: number): PromptLinkEdit | null {
  const link = findSmartLinks(value).find(({ start, end }) => cursor >= start && cursor < end);
  return link
    ? { value: `${value.slice(0, link.start)}${value.slice(link.end)}`, cursor: link.start }
    : null;
}

/**
 * The chip strip under the TUI prompt. It reads from the shared chip model so
 * the TUI names a link exactly as the desktop and iOS do: an `ade://pr/...`
 * link shows as `#1237`, not as the generic `ADE · pr/owner/repo/1237` the
 * provider glyph alone produced.
 */
export function formatPromptSmartLinkStrip(
  links: readonly SmartLinkMatch[],
  models: readonly ParsedModelMention[] = [],
): string {
  const chips = [
    ...links.map((link) => chipFromSmartLink(link)),
    ...models.map((model) => chipFromModelMention(model, model.token)),
  ];
  const label = models.length > 0 ? "chips" : "links";
  return `${label} ${chips
    .map((chip) => `[${chipGlyphAscii(chip.kind)} ${chipDisplayLabel(chip)}]`)
    .join(" ")}`;
}

/**
 * A sent message shows each model token as its chip, `[M DeepSeek V4.1 Flash
 * · High · Full access]`, the way desktop and iOS draw it. The stored text
 * keeps the raw token.
 */
export function renderModelMentionChipsInText(text: string): string {
  const mentions = parseModelMentions(text);
  if (!mentions.length) return text;
  let out = "";
  let pos = 0;
  for (const mention of mentions) {
    const chip = chipFromModelMention(mention, mention.token);
    out += `${text.slice(pos, mention.start)}[${chipGlyphAscii(chip.kind)} ${chipDisplayLabel(chip)}]`;
    pos = mention.end;
  }
  return out + text.slice(pos);
}
