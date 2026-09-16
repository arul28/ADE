// Render message text with its special tokens drawn as compact pills.
//
// A sent message used to print `event.text` into a `whitespace-pre-wrap` div,
// so everything the composer had shown as a chip reverted to raw text the
// moment it was sent: a full github.com URL, an opaque `@chat:<uuid>`, a long
// repo path. The composer and the transcript disagreed about the same message.
//
// This component closes that gap using the shared chip model, so the composer,
// the transcript, the TUI, and iOS all read one description of what a chip is.
// The raw text is never destroyed — it is still `event.text`, the copy button
// still yields canonical tokens, and a chip's `title` shows the token it stands
// for.
//
// Two things a sent pill does that its composer twin already did:
//
//   - **Enrichment.** The composer asks the runtime for a page title and
//     favicon and redraws its chip when the answer lands; the transcript now
//     asks the SAME route (`chipPreviewStore`) and swaps the same two fields in.
//     The first paint is always synchronous from the raw label, so a message
//     never waits on the network to appear.
//   - **Hover cards.** A pointer chip (`#1237`, a lane id, a chat id, `ADE-431`)
//     answers "what is this" on hover instead of sending you to another tab.

import { useMemo } from "react";

import { buildDeeplink } from "../../../shared/deeplinks";
import { chipDisplayLabel, chipGlyph, splitTextIntoChipParts, type Chip } from "../../../shared/chips";
import { deriveSmartLinkPreview, type SmartLinkProvider } from "../../../shared/smartLinks";
import { navigateToAppTarget, openAdeDeeplink, openLinkFromUi } from "../../lib/openExternal";
import { useChipHoverCard } from "./ChipHoverCard";
import { chipPreviewUrl, useChipPreview } from "./chipPreviewStore";
import { smartLinkChipMarkSvg } from "./smartLinkChipMark";

/** Where a click on this chip should land, or null when it is not actionable. */
function openChip(chip: Chip): void {
  const source = chip.source;
  if (source.origin === "deeplink") {
    openAdeDeeplink(source.url);
    return;
  }
  if (source.origin === "url") {
    openLinkFromUi(source.url);
    return;
  }
  if (source.origin === "path") {
    // A FOLDER is not openable: the navigation target is `kind: "file"`, and
    // handing it `src/shared/` asks the editor for a file that does not exist.
    // `isActionable` already refuses the click; this is the second half of that
    // contract so no future caller can route one here by accident.
    if (chip.kind === "folder") return;
    navigateToAppTarget({ kind: "file", path: source.path, line: null, laneId: null });
    return;
  }
  if (source.mentionKind === "chat") {
    openAdeDeeplink(buildDeeplink({ kind: "session", sessionId: source.id }));
    return;
  }
  if (source.mentionKind === "lane") {
    openAdeDeeplink(buildDeeplink({ kind: "lane", laneId: source.id }));
  }
  // A terminal mention has no deeplink target; it stays a label.
}

function isActionable(chip: Chip): boolean {
  // A folder chip is a label, like a terminal mention: there is no folder
  // destination to open, and a pill that looks clickable and does nothing is
  // worse than one that plainly is not. iOS reaches the same answer for the
  // same reason (`workChipNavigationURL` returns nil for a path).
  if (chip.kind === "folder") return false;
  return chip.source.origin !== "mention" || chip.source.mentionKind !== "terminal";
}

/**
 * Brand mark for a web-link chip, matching the composer's icon slot.
 *
 * Only http(s) chips take a mark. An `ade://` chip stays on its TYPED glyph
 * (`⇄` for a PR, `◫` for a lane) because the deeplink already told us exactly
 * what it points at, and an ADE monogram would throw that away.
 */
function chipProvider(chip: Chip): SmartLinkProvider | null {
  if (chip.source.origin !== "url") return null;
  if (!/^https?:\/\//i.test(chip.source.url)) return null;
  return deriveSmartLinkPreview(chip.source.url)?.provider ?? null;
}

function chipProviderMarkSvg(chip: Chip): string | null {
  const provider = chipProvider(chip);
  return provider ? smartLinkChipMarkSvg(provider) : null;
}

const ICON_MARK_CLASS = "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center opacity-80";

function ChipIcon({ chip, markSvg, iconDataUrl }: { chip: Chip; markSvg: string | null; iconDataUrl: string | null }) {
  if (iconDataUrl) {
    return (
      <span aria-hidden className={ICON_MARK_CLASS}>
        <img src={iconDataUrl} alt="" draggable={false} className="h-full w-full rounded-[2px] object-contain" />
      </span>
    );
  }
  // Constant, module-owned SVG selected by a provider enum — `smartLinkChipMark`
  // interpolates nothing from the message. The composer assigns the same string
  // to `innerHTML`; this is the React spelling of that, not a new trust boundary.
  if (markSvg) return <span aria-hidden className={ICON_MARK_CLASS} dangerouslySetInnerHTML={{ __html: markSvg }} />;
  return <span aria-hidden className="shrink-0 opacity-70">{chipGlyph(chip.kind)}</span>;
}

const CHIP_CLASS =
  "mx-0.5 inline-flex max-w-[280px] translate-y-[1px] items-center gap-1 rounded-md border border-white/[0.14]"
  + " bg-white/[0.08] px-1.5 py-0.5 align-baseline font-sans text-[length:calc(var(--chat-font-size)*11/14)]"
  + " leading-5 text-white/90";

/**
 * One pill. A component rather than inline JSX because each chip owns two
 * subscriptions (its preview, its hover card) and those must not re-render the
 * whole message — a transcript draws hundreds of these.
 */
function TranscriptChip({ chip }: { chip: Chip }) {
  // The chip object comes from a memoized parse, so these are stable per
  // message — neither the URL parse nor the provider lookup reruns on a
  // re-render, which matters when a transcript holds hundreds of pills.
  const previewUrl = useMemo(() => chipPreviewUrl(chip), [chip]);
  const markSvg = useMemo(() => chipProviderMarkSvg(chip), [chip]);
  const preview = useChipPreview(previewUrl);

  const label = chipDisplayLabel(preview?.title ? { ...chip, title: preview.title } : chip);
  const actionable = isActionable(chip);
  const hoverCard = useChipHoverCard(chip, preview?.title ?? null);
  const tokenTitle = chip.detail ? `${chip.token} — ${chip.detail}` : chip.token;

  return (
    <>
      <span
        ref={hoverCard.triggerRef}
        className={`${CHIP_CLASS}${actionable ? " cursor-pointer transition-colors hover:bg-white/[0.14]" : ""}`}
        // The token is the truth behind the label; a hover always reveals it.
        // Suppressed only while a hover card is up, so the OS tooltip does not
        // draw a second box on top of it.
        title={hoverCard.visible ? undefined : tokenTitle}
        role={actionable ? "button" : undefined}
        tabIndex={actionable ? 0 : undefined}
        onClick={actionable ? () => openChip(chip) : undefined}
        onKeyDown={actionable
          ? (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openChip(chip);
          }
          : undefined}
        {...hoverCard.triggerProps}
      >
        <ChipIcon chip={chip} markSvg={markSvg} iconDataUrl={preview?.iconDataUrl ?? null} />
        <span className="truncate">{label}</span>
      </span>
      {hoverCard.card}
    </>
  );
}

export function ChipText({ text, className }: { text: string; className?: string }) {
  // Memoized on the text: this renders for every user message in the
  // transcript, and the parse runs two regex scans plus a URL parse per link.
  const parts = useMemo(() => splitTextIntoChipParts(text), [text]);

  // No chips: keep the exact original node so nothing about plain messages
  // changes — spacing, selection, and copy stay byte-for-byte what they were.
  if (parts.every((part) => part.type === "text")) {
    return <div className={className}>{text}</div>;
  }

  return (
    <div className={className}>
      {parts.map((part, index) => (
        part.type === "text"
          ? <span key={`t-${index}`}>{part.text}</span>
          : <TranscriptChip key={`c-${index}`} chip={part.chip} />
      ))}
    </div>
  );
}
