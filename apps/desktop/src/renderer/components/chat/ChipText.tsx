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

import { useMemo, useRef, useState, type CSSProperties } from "react";
import {
  GitBranch,
  GitCommit,
  GearSix,
  GitPullRequest,
  Globe,
  Images,
  Lightning,
  Lock,
  SignIn,
  type Icon,
} from "@phosphor-icons/react";

import { resolveAttachmentToken } from "../../../shared/attachmentLabels";
import { getModelById } from "../../../shared/modelRegistry";
import { chipDisplayLabel, chipGlyph, splitTextIntoChipParts, type Chip, type ChipTextPart } from "../../../shared/chips";
import type { AgentChatFileRef } from "../../../shared/types";
import { basenameCrossPlatform } from "../../../shared/pathDisplay";
import { deriveSmartLinkPreview, type SmartLinkProvider } from "../../../shared/smartLinks";
import { permissionModePresentation, permissionToneTextClass } from "../shared/permissionModePickerOptions";
import { PermissionModeGlyph } from "../shared/PermissionModePicker";
import { ModelRowLogo } from "../shared/ProviderLogos";
import { useChipHoverCard, useChipScopeSources, type ChipScopeSources } from "./ChipHoverCard";
import { chipPreviewUrl, useChipPreview } from "./chipPreviewStore";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { useChatWorkspacePathOpener } from "./chatWorkspacePaths";
import { mentionChipMarkSvg } from "./mentionChipMark";
import { smartLinkChipMarkSvg } from "./smartLinkChipMark";
import { AttachmentPeekCard, useAttachmentThumbnail } from "./AttachmentChipPeek";
import { useAttachmentPreview } from "./ChatAttachmentTray";
import { useMentionChipResolution } from "./mentionChipLabels";
import { getFileIcon } from "../files/filePresentation";
import { buildChipMenuEntries } from "./chipMenu";
import { chipMenuExtras, isChipActionable, openChipTarget, type ChipActionContext } from "./chipActions";
import { useMachineFacts } from "./useMachineFacts";
import { isComputerSettingsEntry, settingsEntryById, settingsEntryLabelPath, settingUnavailableReason } from "../settings/settingsManifest";
import { settingIsProtected } from "../../../shared/settingsAgentAccess";

type SettingChipFacts = {
  parts: string[];
  /** A protected setting (publishing, sign-ins, money…): drawn with a lock. */
  locked: boolean;
  /** Why this window cannot open it, or null. Drawn muted. */
  unavailable: string | null;
};

/**
 * A settings chip's face, from this build's manifest: the path as the sidebar
 * names it (with the chat machine's name on a Computer page), a lock on the
 * settings that guard your work, and whether this window can open it at all.
 * Nothing here comes from the agent's text.
 */
function settingChipFacts(chip: Chip, machineName: string): SettingChipFacts | null {
  if (chip.kind !== "setting" || chip.source.origin !== "deeplink" || chip.source.target.kind !== "settings") return null;
  const entry = settingsEntryById(chip.source.target.entryId);
  if (!entry) return null;
  // A link that names its own machine opens that one, so the chat machine's
  // name would be wrong; leave the machine out of the path.
  const named = isComputerSettingsEntry(entry) && !chip.source.target.machineId;
  return {
    parts: settingsEntryLabelPath(entry, named ? machineName : null),
    locked: settingIsProtected(entry.id),
    unavailable: settingUnavailableReason(entry),
  };
}

/**
 * `Computer › Studio › Providers › AI connections`, shortened in the middle
 * when it does not fit, so the group and the setting itself always show.
 */
function SettingPathLabel({ parts }: { parts: string[] }) {
  if (parts.length < 3) return <span className="truncate">{parts.join(" › ")}</span>;
  const first = parts[0];
  const last = parts[parts.length - 1];
  const middle = parts.slice(1, -1).join(" › ");
  return (
    <span className="flex min-w-0 items-baseline">
      <span className="shrink-0 whitespace-pre">{first} › </span>
      <span className="min-w-[1.5em] shrink-[4] truncate">{middle}</span>
      <span className="shrink-0 whitespace-pre"> › </span>
      <span className="min-w-0 truncate">{last}</span>
    </span>
  );
}
import { cn } from "../ui/cn";

/** The hover title: the token, or for an attached tab the tab itself (its token is the agent's instruction block). */
function chipTokenTitle(chip: Chip, label: string): string {
  if (chip.kind === "browser_tab") return [label, chip.detail].filter(Boolean).join(" — ");
  return chip.detail ? `${chip.token} — ${chip.detail}` : chip.token;
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
  browser_tab: Globe,
  setting: GearSix,
  place: SignIn,
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
    const presentation = permissionModePresentation(chip.source.provider, chip.source.value);
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
  if (chip.kind === "lane" || chip.kind === "chat" || chip.kind === "terminal" || chip.kind === "machine" || chip.kind === "mcp" || chip.kind === "file") {
    return <span aria-hidden className={ICON_MARK_CLASS} dangerouslySetInnerHTML={{ __html: mentionChipMarkSvg(chip.kind) }} />;
  }
  return <span aria-hidden className="shrink-0 opacity-70">{chipGlyph(chip.kind)}</span>;
}

// One weight and size wherever a chip sits: inside **bold** prose it must not
// turn bold, inside a heading it must not grow. Tinted with the theme's accent
// so a chip reads as a button when scanning the thread, in light and dark.
const CHIP_CLASS =
  "mx-0.5 inline-flex max-w-[280px] translate-y-[1px] items-center gap-1 rounded-md border border-accent/[0.38]"
  + " bg-accent/[0.14] px-1.5 py-px align-baseline font-sans text-[length:calc(var(--chat-font-size)*11.5/14)]"
  + " font-medium not-italic leading-5 tracking-normal"
  + " text-[color:color-mix(in_srgb,var(--color-accent)_40%,var(--color-fg))]";
const CHIP_HOVER_CLASS = " cursor-pointer transition-[filter,background-color,border-color] hover:border-accent/60 hover:bg-accent/[0.24]";

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
  // `@pr:` / `@mac:` chips carry only an id; resolve "#1319 title" / the
  // machine name from data the renderer already reads (short id when unknown).
  const mention = useMentionChipResolution(chip, chatScope);
  const machineKey = chip.source.origin === "mention" && chip.source.mentionKind === "machine" ? chip.source.id : null;
  const machineFacts = useMachineFacts(machineKey);
  // A terminal's name lives in the chat machine's session roster.
  const terminalId = chip.source.origin === "mention" && chip.source.mentionKind === "terminal"
    ? chip.source.id.toLowerCase()
    : null;
  const terminalLabel = terminalId
    ? scoped.sessions?.find((session) => session.id.toLowerCase() === terminalId)?.title?.trim() || null
    : null;
  const setting = useMemo(() => settingChipFacts(chip, chatScope.machineName), [chip, chatScope.machineName]);
  const label = setting
    ? setting.parts.join(" › ")
    : terminalLabel ?? mention.label ?? facts.label ?? chipDisplayLabel(preview?.title ? { ...chip, title: preview.title } : chip);
  const actionContext: ChipActionContext = {
    scope: chatScope,
    lanes: scoped.lanes,
    sessions: scoped.sessions,
    openWorkspacePath,
    prTarget: mention.prTarget,
    machineFacts: machineFacts ?? null,
    openMenu: () => openMenuRef.current(),
  };
  const actionable = isChipActionable(chip, actionContext);
  const open = () => openChipTarget(chip, actionContext);
  // Built only when a menu opens (held hover, right-click), never per render.
  // A machine's click IS its menu, so its menu has no "open" row.
  const menuEntries = () => buildChipMenuEntries(chip, {
    label,
    open: actionable && !machineKey ? open : null,
    extra: chipMenuExtras(chip, actionContext),
    runtimePin: chatScope.pin,
  });
  const hoverCard = useChipHoverCard(chip, preview?.title ?? null, scoped, preview?.imageUrl ?? null, menuEntries);
  const openMenuRef = useRef(hoverCard.openMenu);
  openMenuRef.current = hoverCard.openMenu;
  const tokenTitle = machineFacts
    ? [machineFacts.name, machineFacts.route, machineFacts.latency].filter(Boolean).join(" · ")
    : chipTokenTitle(chip, label);

  return (
    <>
      <span
        ref={hoverCard.triggerRef}
        className={`${CHIP_CLASS}${setting ? " max-w-[360px]" : ""}${setting?.unavailable ? " opacity-60" : ""}${actionable ? CHIP_HOVER_CLASS : ""}`}
        style={laneColorStyle(facts.color)}
        data-chip-kind={chip.kind}
        // The token is the truth behind the label; a hover always reveals it.
        // Suppressed only while a hover card is up, so the OS tooltip does not
        // draw a second box on top of it.
        title={hoverCard.visible ? undefined : tokenTitle}
        role={actionable ? "button" : undefined}
        onClick={actionable ? open : undefined}
        {...hoverCard.triggerProps}
        // Focusable even when a click does nothing, so the menu (Shift+F10)
        // stays reachable from the keyboard.
        tabIndex={actionable || hoverCard.supported ? 0 : undefined}
        onKeyDown={(event) => {
          hoverCard.triggerProps.onKeyDown?.(event);
          if (!actionable || event.defaultPrevented) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          open();
        }}
      >
        {setting?.locked ? (
          <span aria-label="Only you can change this" className={`${ICON_MARK_CLASS} text-amber-200`}>
            <Lock size={12} weight="bold" />
          </span>
        ) : (
          <ChipIcon chip={chip} markSvg={markSvg} iconDataUrl={preview?.iconDataUrl ?? null} />
        )}
        {setting ? <SettingPathLabel parts={setting.parts} /> : <span className="truncate">{label}</span>}
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

/**
 * An `[Image #k]` / `[File #k: name]` pill, resolved against the message's own
 * attachments: a 14px thumbnail for an image, the file-type glyph for a file.
 * Hover peeks the image; a click opens the same preview the tray item opens.
 */
function AttachmentTranscriptChip({ chip, attachment }: { chip: Chip; attachment: AgentChatFileRef }) {
  const pin = useChatRuntimeScope().pin;
  const thumbnail = useAttachmentThumbnail(attachment, pin);
  const name = attachment.type === "image-url"
    ? basenameCrossPlatform(attachment.url) || attachment.url
    : basenameCrossPlatform(attachment.path) || attachment.path;
  const preview = useAttachmentPreview({
    path: attachment.path,
    title: name,
    pin,
    fallbackImageDataUrl: thumbnail,
  });
  const [peekAnchor, setPeekAnchor] = useState<HTMLElement | null>(null);
  const isImage = attachment.type === "image" || attachment.type === "image-url";
  const { icon: FileIcon, color } = getFileIcon(name);

  return (
    <>
      <span
        className={`${CHIP_CLASS}${CHIP_HOVER_CLASS}`}
        data-chip-kind={chip.kind}
        title={`${chip.token} — ${name}`}
        role="button"
        tabIndex={0}
        data-chat-attachment-chip=""
        onClick={preview.open}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          preview.open();
        }}
        onMouseEnter={(event) => setPeekAnchor(event.currentTarget)}
        onMouseLeave={() => setPeekAnchor(null)}
        // The chip is focusable, so the peek must open for keyboard users too.
        onFocus={(event) => setPeekAnchor(event.currentTarget)}
        onBlur={() => setPeekAnchor(null)}
      >
        {isImage && thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            aria-hidden
            draggable={false}
            className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-cover"
          />
        ) : isImage ? (
          <span aria-hidden className="shrink-0 opacity-70">{chipGlyph(chip.kind)}</span>
        ) : (
          <FileIcon size={12} weight="bold" style={{ color }} className="shrink-0" aria-hidden />
        )}
        <span className="truncate">{chip.label}</span>
      </span>
      {isImage ? <AttachmentPeekCard anchor={peekAnchor} src={thumbnail} name={name} /> : null}
      {preview.element}
    </>
  );
}

type ResolvedChipTextPart =
  | ChipTextPart
  | { type: "attachment"; chip: Chip; attachment: AgentChatFileRef };

/**
 * Resolve attachment chips against `attachments`. A token whose ordinal has no
 * attachment is not a chip — it folds back into the surrounding text, so a
 * literal "[Image #3]" in a message with two images reads as typed.
 */
function resolveAttachmentParts(
  parts: ChipTextPart[],
  attachments: readonly AgentChatFileRef[] | undefined,
): ResolvedChipTextPart[] {
  const out: ResolvedChipTextPart[] = [];
  const pushText = (text: string) => {
    const last = out[out.length - 1];
    if (last?.type === "text") out[out.length - 1] = { type: "text", text: last.text + text };
    else out.push({ type: "text", text });
  };
  for (const part of parts) {
    if (part.type === "text") {
      pushText(part.text);
      continue;
    }
    const source = part.chip.source;
    if (source.origin !== "attachment") {
      out.push(part);
      continue;
    }
    const attachment = attachments?.length
      ? resolveAttachmentToken(attachments, { kind: source.attachmentKind, ordinal: source.ordinal })
      : null;
    if (attachment) out.push({ type: "attachment", chip: part.chip, attachment });
    else pushText(part.chip.token);
  }
  return out;
}

export function ChipText({
  text,
  className,
  attachments,
}: {
  text: string;
  className?: string;
  /**
   * The message's attachments, in order. `[Image #k]` / `[File #k: …]` tokens
   * resolve against this list; without it they stay plain text.
   */
  attachments?: readonly AgentChatFileRef[];
}) {
  // Memoized on the text: this renders for every user message in the
  // transcript, and the parse runs two regex scans plus a URL parse per link.
  const parts = useMemo(
    () => resolveAttachmentParts(splitTextIntoChipParts(text), attachments),
    [attachments, text],
  );

  // No chips: one text node, not a span per part.
  // Hebrew or Arabic reads right to left: `dir="auto"` isolates the message and
  // `unicode-bidi: plaintext` lets each line take its own direction, so an
  // English line in a Hebrew message still starts on the left.
  if (parts.every((part) => part.type === "text")) {
    return <div dir="auto" className={cn(className, "[unicode-bidi:plaintext]")}>{text}</div>;
  }

  return (
    <div dir="auto" className={cn(className, "[unicode-bidi:plaintext]")}>
      {parts.map((part, index) => {
        if (part.type === "text") return <span key={`t-${index}`}>{part.text}</span>;
        if (part.type === "attachment") {
          return <AttachmentTranscriptChip key={`a-${index}`} chip={part.chip} attachment={part.attachment} />;
        }
        return <TranscriptChip key={`c-${index}`} chip={part.chip} />;
      })}
    </div>
  );
}
