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

import { useMemo, type CSSProperties } from "react";
import {
  GitBranch,
  GitCommit,
  GitPullRequest,
  Images,
  Lightning,
  type Icon,
} from "@phosphor-icons/react";

import { buildDeeplink } from "../../../shared/deeplinks";
import { getModelById } from "../../../shared/modelRegistry";
import { chipDisplayLabel, chipGlyph, splitTextIntoChipParts, type Chip } from "../../../shared/chips";
import { deriveSmartLinkPreview, type SmartLinkProvider } from "../../../shared/smartLinks";
import { navigateToAppTarget, openAdeDeeplink, openLinkFromUi } from "../../lib/openExternal";
import { modelPermissionPresentation, permissionToneTextClass } from "../../lib/modelPermissionOptions";
import { PermissionModeGlyph } from "../shared/PermissionModePicker";
import { ModelRowLogo } from "../shared/ProviderLogos";
import { useChipHoverCard, useChipScopeSources, type ChipScopeSources } from "./ChipHoverCard";
import { chipPreviewUrl, useChipPreview } from "./chipPreviewStore";
import { useChatRuntimeScope, type ChatRuntimeScope } from "./ChatRuntimeScope";
import { useChatWorkspacePathOpener, type ChatWorkspacePathOpener } from "./chatWorkspacePaths";
import { rootAppStoreApi } from "../../state/appStore";
import { machineEntryForBinding } from "../../state/crossMachineLanes";
import { mentionChipMarkSvg } from "./mentionChipMark";
import { smartLinkChipMarkSvg } from "./smartLinkChipMark";

/**
 * The machine that holds the chat's lane, or null when the chat runs on the
 * tab's own machine. Read on click, so a transcript of pills holds no extra
 * store subscription.
 */
function chatMachineId(scope: Pick<ChatRuntimeScope, "pin">): string | null {
  return machineEntryForBinding(rootAppStoreApi.getState(), scope.pin)?.machineId ?? null;
}

/** Where a click on this chip should land, or null when it is not actionable. */
function openChip(
  chip: Chip,
  scope: Pick<ChatRuntimeScope, "laneId" | "pin">,
  openWorkspacePath: ChatWorkspacePathOpener | null,
): void {
  const source = chip.source;
  if (source.origin === "deeplink") {
    // A bare SHA in a reply names no lane. It is a commit of the lane this chat
    // works in, on the machine this chat runs on. Without that, the click has
    // nothing to open and shows the "lives on another machine" modal.
    if (source.target.kind === "commit" && !source.target.laneId && scope.laneId) {
      navigateToAppTarget({
        kind: "commit",
        sha: source.target.sha,
        laneId: scope.laneId,
        machineId: chatMachineId(scope),
      });
      return;
    }
    // `#1407` in an agent's reply names a PR with no repo. A deeplink must name
    // the repo to parse, so that one opens through the in-app PR route, which
    // resolves the number against this project's PRs.
    if (source.target.kind === "pr" && !source.target.repoOwner) {
      navigateToAppTarget({ kind: "pr", prNumber: source.target.prNumber });
      return;
    }
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
    // Inside a chat, a path is relative to the chat's lane on the chat's
    // machine. The chat's opener resolves both; the bare route below would
    // open the path under the tab's project root instead.
    if (openWorkspacePath) {
      openWorkspacePath(source.path);
      return;
    }
    navigateToAppTarget({ kind: "file", path: source.path, line: null, laneId: null });
    return;
  }
  // A model, permission or skill chip names a setting, not a place.
  if (source.origin === "model" || source.origin === "permission" || source.origin === "skill") return;
  if (source.mentionKind === "chat") {
    openAdeDeeplink(buildDeeplink({ kind: "session", sessionId: source.id }));
    return;
  }
  if (source.mentionKind === "lane") {
    // A lane mention resolves against the chat's machine, so it opens there.
    navigateToAppTarget({ kind: "lane", laneId: source.id, machineId: chatMachineId(scope) });
  }
  // A terminal mention has no deeplink target; it stays a label.
}

function isActionable(chip: Chip): boolean {
  // A folder chip is a label, like a terminal mention: there is no folder
  // destination to open, and a pill that looks clickable and does nothing is
  // worse than one that plainly is not. iOS reaches the same answer for the
  // same reason (`workChipNavigationURL` returns nil for a path).
  if (chip.kind === "folder" || chip.kind === "model" || chip.kind === "permission" || chip.kind === "skill") return false;
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
  // A Linear issue is a Linear issue however it was written: `ADE-159` in
  // prose gets the same mark as a pasted linear.app link.
  if (chip.kind === "linear_issue") return smartLinkChipMarkSvg("linear");
  const provider = chipProvider(chip);
  return provider ? smartLinkChipMarkSvg(provider) : null;
}

/**
 * Kinds whose pill takes an icon from the app's set rather than a text glyph.
 * A web link of the same kind (a github.com PR) keeps its brand mark above.
 */
const KIND_ICONS: Partial<Record<Chip["kind"], Icon>> = {
  commit: GitCommit,
  pr: GitPullRequest,
  branch: GitBranch,
  skill: Lightning,
  artifact: Images,
};

const ICON_MARK_CLASS = "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center opacity-80";

function ChipIcon({ chip, markSvg, iconDataUrl }: { chip: Chip; markSvg: string | null; iconDataUrl: string | null }) {
  if (chip.source.origin === "model") {
    const descriptor = getModelById(chip.source.mention.modelId);
    if (descriptor) {
      return (
        <span aria-hidden className={ICON_MARK_CLASS}>
          <ModelRowLogo
            modelFamily={descriptor.family}
            cliCommand={descriptor.cliCommand}
            modelId={descriptor.id}
            providerModelId={descriptor.providerModelId}
            openCodeProviderId={descriptor.openCodeProviderId}
            size={12}
          />
        </span>
      );
    }
  }
  if (chip.source.origin === "permission") {
    const presentation = modelPermissionPresentation(chip.source.provider, chip.source.value);
    return (
      <span aria-hidden className={`${ICON_MARK_CLASS} ${permissionToneTextClass(presentation.tone)}`}>
        <PermissionModeGlyph icon={presentation.icon} size={11} />
      </span>
    );
  }
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
  const kindIcon = KIND_ICONS[chip.kind];
  if (kindIcon) {
    const KindIcon = kindIcon;
    return (
      <span aria-hidden className={ICON_MARK_CLASS}>
        <KindIcon size={12} weight="bold" />
      </span>
    );
  }
  // The composer's own kind marks, so a sent pill looks like the one typed.
  if (chip.kind === "lane" || chip.kind === "chat" || chip.kind === "terminal" || chip.kind === "file") {
    return <span aria-hidden className={ICON_MARK_CLASS} dangerouslySetInnerHTML={{ __html: mentionChipMarkSvg(chip.kind) }} />;
  }
  return <span aria-hidden className="shrink-0 opacity-70">{chipGlyph(chip.kind)}</span>;
}

// One weight and size wherever a chip sits: inside **bold** prose it must not
// turn bold, inside a heading it must not grow.
const CHIP_CLASS =
  "mx-0.5 inline-flex max-w-[280px] translate-y-[1px] items-center gap-1 rounded-md border border-white/[0.14]"
  + " bg-white/[0.08] px-1.5 py-px align-baseline font-sans text-[length:calc(var(--chat-font-size)*11.5/14)]"
  + " font-medium not-italic leading-5 tracking-normal text-white/90";

type ChipFacts = {
  /** The entity's real name: the lane name, the chat title. */
  label: string | null;
  /** The lane's own colour, so the pill matches the lane everywhere else. */
  color: string | null;
  /** A live chat state, drawn as a dot. */
  live: "running" | "waiting" | null;
};

const NO_FACTS: ChipFacts = { label: null, color: null, live: null };

/**
 * What ADE knows right now about a lane or chat chip, read from the CHAT's
 * machine (see `ChipHoverCard` for why it is never the project tab's lanes).
 * The parse only knows an id; the name, colour and state are live.
 */
function useChipFacts(chip: Chip, { lanes, sessions }: ChipScopeSources): ChipFacts {
  const target = chipEntityTarget(chip);
  const lane = target?.kind === "lane"
    ? lanes?.find((candidate) => candidate.id.toLowerCase() === target.id) ?? null
    : null;
  const session = target?.kind === "chat"
    ? sessions?.find((candidate) => candidate.id.toLowerCase() === target.id) ?? null
    : null;
  return useMemo(() => {
    if (lane) return { label: lane.name, color: lane.color?.trim() || null, live: null };
    if (session) {
      const live = session.runtimeState === "waiting-input" || session.attentionRequestedAt
        ? "waiting" as const
        : session.status === "running" && session.runtimeState === "running"
          ? "running" as const
          : null;
      return { label: session.title?.trim() || session.goal?.trim() || null, color: null, live };
    }
    return NO_FACTS;
  }, [lane, session]);
}

function chipEntityTarget(chip: Chip): { kind: "lane" | "chat"; id: string } | null {
  const source = chip.source;
  if (source.origin === "mention" && (source.mentionKind === "lane" || source.mentionKind === "chat")) {
    return { kind: source.mentionKind, id: source.id.toLowerCase() };
  }
  if (source.origin === "deeplink" && source.target.kind === "lane") {
    return { kind: "lane", id: source.target.laneId.toLowerCase() };
  }
  if (source.origin === "deeplink" && source.target.kind === "session") {
    return { kind: "chat", id: source.target.sessionId.toLowerCase() };
  }
  return null;
}

function laneColorStyle(color: string | null): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    borderColor: `color-mix(in srgb, ${color} 42%, transparent)`,
    background: `color-mix(in srgb, ${color} 16%, transparent)`,
    color: `color-mix(in srgb, ${color} 62%, white)`,
  };
}

/**
 * One pill. A component rather than inline JSX because each chip owns two
 * subscriptions (its preview, its hover card) and those must not re-render the
 * whole message — a transcript draws hundreds of these.
 */
export function TranscriptChip({ chip }: { chip: Chip }) {
  // The chip object comes from a memoized parse, so these are stable per
  // message — neither the URL parse nor the provider lookup reruns on a
  // re-render, which matters when a transcript holds hundreds of pills.
  const previewUrl = useMemo(() => chipPreviewUrl(chip), [chip]);
  const markSvg = useMemo(() => chipProviderMarkSvg(chip), [chip]);
  const preview = useChipPreview(previewUrl);

  const scoped = useChipScopeSources();
  const chatScope = useChatRuntimeScope();
  const openWorkspacePath = useChatWorkspacePathOpener();
  const facts = useChipFacts(chip, scoped);
  const label = facts.label ?? chipDisplayLabel(preview?.title ? { ...chip, title: preview.title } : chip);
  const actionable = isActionable(chip);
  const hoverCard = useChipHoverCard(chip, preview?.title ?? null, scoped);
  const tokenTitle = chip.detail ? `${chip.token} — ${chip.detail}` : chip.token;

  return (
    <>
      <span
        ref={hoverCard.triggerRef}
        className={`${CHIP_CLASS}${actionable ? " cursor-pointer transition-[filter,background-color] hover:bg-white/[0.14] hover:brightness-125" : ""}`}
        style={laneColorStyle(facts.color)}
        data-chip-kind={chip.kind}
        // The token is the truth behind the label; a hover always reveals it.
        // Suppressed only while a hover card is up, so the OS tooltip does not
        // draw a second box on top of it.
        title={hoverCard.visible ? undefined : tokenTitle}
        role={actionable ? "button" : undefined}
        tabIndex={actionable ? 0 : undefined}
        onClick={actionable ? () => openChip(chip, chatScope, openWorkspacePath) : undefined}
        onKeyDown={actionable
          ? (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openChip(chip, chatScope, openWorkspacePath);
          }
          : undefined}
        {...hoverCard.triggerProps}
      >
        <ChipIcon chip={chip} markSvg={markSvg} iconDataUrl={preview?.iconDataUrl ?? null} />
        <span className="truncate">{label}</span>
        {facts.live ? (
          <span
            aria-label={facts.live === "running" ? "Running" : "Needs you"}
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${facts.live === "running" ? "animate-pulse bg-emerald-400" : "bg-amber-400"}`}
          />
        ) : null}
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
