import {
  findSmartLinks,
  smartLinkDisplayLabel,
  smartLinkProviderGlyph,
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

export function formatPromptSmartLinkStrip(links: readonly SmartLinkMatch[]): string {
  return `links ${links
    .map((link) => `[${smartLinkProviderGlyph(link.provider)} ${smartLinkDisplayLabel(link)}]`)
    .join(" ")}`;
}
