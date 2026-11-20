import { cn } from "../ui/cn";
import type { ChatAttachmentPendingImage } from "./ChatAttachmentTray";
import { COMPOSER_MENTION_CHIP_CLASS, COMPOSER_TOKEN_CHIP_ICON_CLASS } from "./mentionChipMark";

export const COMPOSER_ATTACHMENT_THUMB_CLASS = "inline-flex h-3.5 w-3.5 shrink-0 overflow-hidden rounded-[3px]";
export const COMPOSER_IMAGE_CHIP_GLYPH_SVG =
  '<svg viewBox="0 0 16 16" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.6"/><circle cx="6" cy="6.6" r="1.1"/><path d="M3 11.8l3.2-3.2 2.4 2.4 1.8-1.8 2.6 2.6"/></svg>';

// An image still uploading (or one that failed) holds its place in the prompt
// as this token, put at the caret when it was pasted. It serializes to nothing;
// when the upload lands the real chip replaces it in place, so the caret and
// whatever was typed since stay put. `data-composer-pending-id` is the
// pending record's id, the same record the tray tile draws.
export const COMPOSER_PENDING_ATTACHMENT_CHIP_SELECTOR = "[data-composer-chip='attachment-pending']";

/** A failed token's tint: the kit's warning tone, not a hardcoded palette step. */
const FAILED_CHIP_CLASS =
  "border-[color:color-mix(in_srgb,var(--kit-warn)_45%,transparent)] text-[color:color-mix(in_srgb,var(--kit-warn)_70%,var(--color-fg))]";
const FAILED_RETRY_CLASS =
  "ml-1 cursor-pointer rounded px-0.5 font-medium text-[color:color-mix(in_srgb,var(--kit-warn)_40%,var(--color-fg))] hover:bg-fg/10";
const FAILED_REMOVE_CLASS =
  "cursor-pointer rounded px-0.5 text-[color:color-mix(in_srgb,var(--kit-warn)_45%,transparent)] hover:bg-fg/10 hover:text-fg";

export function findPendingAttachmentChip(editor: HTMLElement, pendingId: string): HTMLElement | null {
  for (const chip of Array.from(editor.querySelectorAll<HTMLElement>(COMPOSER_PENDING_ATTACHMENT_CHIP_SELECTOR))) {
    if (chip.dataset.composerPendingId === pendingId) return chip;
  }
  return null;
}

export function collectPendingAttachmentChipIds(editor: HTMLElement): Set<string> {
  const ids = new Set<string>();
  editor.querySelectorAll<HTMLElement>(COMPOSER_PENDING_ATTACHMENT_CHIP_SELECTOR).forEach((chip) => {
    if (chip.dataset.composerPendingId) ids.add(chip.dataset.composerPendingId);
  });
  return ids;
}

/** Removes a chip and the space put after it. */
export function removeChipWithTrailingSpace(chip: HTMLElement): void {
  const next = chip.nextSibling;
  chip.remove();
  if (next?.nodeType === Node.TEXT_NODE && next.textContent?.startsWith(" ")) {
    next.textContent = next.textContent.slice(1);
  }
}

/** Draw an uploading token in its record's state: the picture, then Retry and × once it failed. */
export function updatePendingAttachmentChipNode(chip: HTMLElement, pending: ChatAttachmentPendingImage): void {
  const failed = Boolean(pending.error);
  const state = failed ? "failed" : "uploading";
  const preview = pending.previewUrl ?? "";
  if (chip.dataset.composerPendingState === state && chip.dataset.composerPendingPreview === preview) return;
  chip.dataset.composerPendingState = state;
  chip.dataset.composerPendingPreview = preview;
  chip.title = failed ? pending.error ?? "" : `Attaching ${pending.name}`;
  chip.setAttribute("aria-label", failed ? `${pending.name} didn't attach` : `Attaching ${pending.name}`);
  chip.className = cn(COMPOSER_MENTION_CHIP_CLASS, failed ? FAILED_CHIP_CLASS : "opacity-70");
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  if (preview) {
    icon.className = cn(COMPOSER_ATTACHMENT_THUMB_CLASS, failed && "opacity-60");
    const image = document.createElement("img");
    image.src = preview;
    image.alt = "";
    image.draggable = false;
    image.className = "h-full w-full object-cover";
    icon.append(image);
  } else {
    icon.className = COMPOSER_TOKEN_CHIP_ICON_CLASS;
    icon.innerHTML = COMPOSER_IMAGE_CHIP_GLYPH_SVG;
  }
  const labelNode = document.createElement("span");
  labelNode.className = "truncate";
  labelNode.textContent = failed ? "Image" : "Image…";
  const parts: HTMLElement[] = [icon, labelNode];
  if (failed) {
    const retry = document.createElement("span");
    retry.dataset.composerPendingRetry = "true";
    retry.className = FAILED_RETRY_CLASS;
    retry.textContent = "Retry";
    retry.title = `Try attaching ${pending.name} again`;
    const remove = document.createElement("span");
    remove.dataset.composerPendingRemove = "true";
    remove.className = FAILED_REMOVE_CLASS;
    remove.textContent = "×";
    remove.title = `Remove ${pending.name}`;
    parts.push(retry, remove);
  }
  chip.replaceChildren(...parts);
}

export function createPendingAttachmentChipNode(pending: ChatAttachmentPendingImage): HTMLElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.composerChip = "attachment-pending";
  // Serializes to nothing: the draft gains the real token only when the image lands.
  chip.dataset.composerChipText = "";
  chip.dataset.composerPendingId = pending.id;
  updatePendingAttachmentChipNode(chip, pending);
  return chip;
}
