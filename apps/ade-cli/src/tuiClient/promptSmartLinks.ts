import {
  chipDisplayLabel,
  chipFromSmartLink,
  chipGlyphAscii,
} from "../../../desktop/src/shared/chips";
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
export function formatPromptSmartLinkStrip(links: readonly SmartLinkMatch[]): string {
  return `links ${links
    .map((link) => {
      const chip = chipFromSmartLink(link);
      return `[${chipGlyphAscii(chip.kind)} ${chipDisplayLabel(chip)}]`;
    })
    .join(" ")}`;
}
