import React from "react";
import { ChatMarkdown } from "../chat/chatMarkdown";
import { buildChatAppearanceRootStyle } from "../chat/chatAppearance";
import { CHAT_SHELL_HEADER_CLASS, ChatSurfaceShell } from "../chat/ChatSurfaceShell";
import { providerChatAccent } from "../chat/chatSurfaceTheme";
import { ChatWorkLogBlock } from "../chat/ChatWorkLogBlock";
import type { ChatWorkLogEntry } from "../chat/chatTranscriptRows";
import {
  CHAT_TRANSCRIPT_GLASS_CARD_CLASS,
  CHAT_USER_MESSAGE_CARD_STYLE,
} from "../chat/chatTranscriptChrome";
import { ClaudeLogo, CodexLogo, CursorAgentLogo, OpenCodeLogo } from "../terminals/ToolLogos";
import { DroidLogo } from "../shared/ProviderLogos";
import { cn } from "../ui/cn";
import type { ChatChromeTint, ChatShellGeometry, ChatTranscriptDensity, ThemeId } from "../../state/appStore";

/** Same user + assistant copy in every column so Codex / Claude / OpenCode only differ by accent + shell chrome. */
const SAMPLE_USER_PROMPT =
  "Refine chat appearance, list files to touch, and give a small table plus code.";

/** Second user turn — keeps the preview feeling like an active thread (no composer mock). */
const SAMPLE_USER_FOLLOWUP =
  "Follow-up: tighten the usage row on light theme and keep tool rails unchanged.";

/** Markdown facets real transcripts use: headings, lists, inline paths, GFM table, fenced code. */
const SAMPLE_ASSISTANT_MARKDOWN = [
  "Here’s a **representative** reply so you can compare how the same thread reads under each provider accent.",
  "",
  "### Files in scope",
  "- `apps/desktop/src/renderer/components/chat/chatAppearance.ts` — density + bubble vars",
  "- `apps/desktop/src/renderer/index.css` — `--chat-row-gap` defaults",
  "",
  "| Density | Row gap | Bubble padding |",
  "|---------|---------|----------------|",
  "| Compact | 6px | tighter |",
  "| Comfortable | 14px | default |",
  "| Spacious | 28px | roomier |",
  "",
  "```ts",
  "export function rowGapForDensity(d: ChatTranscriptDensity): number {",
  "  return d === 'compact' ? 6 : d === 'spacious' ? 28 : 14;",
  "}",
  "```",
  "",
  "Next step: run `npm run test` from `apps/desktop/`.",
].join("\n");

const transcriptPaneClass =
  "flex w-full min-w-0 max-w-full flex-col gap-[length:var(--chat-row-gap)] overflow-x-hidden pl-[length:var(--chat-timeline-pad-x)] pr-[length:var(--chat-timeline-pad-x)] pt-[length:var(--chat-timeline-pad-top)] pb-[length:var(--chat-timeline-pad-bottom)]";

const PREVIEW_WORK_LOG_ENTRIES: ChatWorkLogEntry[] = [
  {
    id: "preview-tool-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "read_file",
    tone: "tool",
    status: "completed",
    entryKind: "tool",
    toolName: "read_file",
    args: { path: "apps/desktop/src/renderer/components/chat/chatAppearance.ts" },
  },
  {
    id: "preview-fc-1",
    createdAt: "2026-01-01T00:00:01.000Z",
    label: "chatAppearance.ts",
    tone: "tool",
    status: "completed",
    entryKind: "file_change",
    changedFiles: [
      {
        path: "apps/desktop/src/renderer/components/chat/chatAppearance.ts",
        kind: "modify",
        additions: 14,
        deletions: 6,
        diff: "@@ -1,6 +1,8 @@\n-      return 8;\n+      return 6;\n",
      },
    ],
  },
];

export type ChatAppearancePreviewProps = {
  theme: ThemeId;
  chatFontSizePx: number;
  transcriptDensity: ChatTranscriptDensity;
  chromeTint: ChatChromeTint;
  shellGeometry: ChatShellGeometry;
  /** When true, draw the user-message minimap rail in each preview column. */
  chatUserMinimapEnabled?: boolean;
};

const PREVIEW_PROVIDER_META = {
  codex: { name: "Codex", Logo: CodexLogo },
  claude: { name: "Claude", Logo: ClaudeLogo },
  opencode: { name: "OpenCode", Logo: OpenCodeLogo },
  cursor: { name: "Cursor", Logo: CursorAgentLogo },
  droid: { name: "Droid", Logo: DroidLogo },
} as const;

type PreviewProviderKey = keyof typeof PREVIEW_PROVIDER_META;

/** Sample model line per column — structure matches `AgentChatMessageList` “done” usage row. */
const PREVIEW_USAGE_MODEL: Record<
  PreviewProviderKey,
  { Logo: React.ComponentType<{ size?: number; className?: string }>; label: string }
> = {
  codex: { Logo: CodexLogo, label: "gpt-5.6-sol" },
  claude: { Logo: ClaudeLogo, label: "Claude Sonnet 5" },
  opencode: { Logo: OpenCodeLogo, label: "local · runtime" },
  cursor: { Logo: CursorAgentLogo, label: "cursor · auto" },
  droid: { Logo: DroidLogo, label: "droid · factory" },
};

/** Mirrors `event.type === "done"` usage footer in `AgentChatMessageList` (completed turn). */
function PreviewUsageRow({ provider }: { provider: PreviewProviderKey }) {
  const { Logo, label } = PREVIEW_USAGE_MODEL[provider];
  const statusTone = "border-white/[0.04] bg-[#141220]/60 text-fg/45";
  return (
    <div className="flex w-full min-w-0 justify-center">
      <div
        className={cn(
          "flex min-w-0 max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-xl border px-4 py-2 font-sans text-[length:calc(var(--chat-font-size)*10/14)]",
          statusTone,
        )}
      >
        <div className="flex min-w-0 w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 sm:w-auto">
          <span className="font-medium text-fg/35 uppercase tracking-wide text-[length:calc(var(--chat-font-size)*9/14)]">
            Usage
          </span>
          <span className="inline-flex items-center gap-1.5 text-fg/30">
            <Logo size={11} className="shrink-0 text-violet-400/40" />
            <span className="font-medium">{label}</span>
          </span>
          <span className="text-fg/25">
            In <span className="font-medium text-fg/35">12.4k</span>
          </span>
          <span className="text-fg/25">
            Out <span className="font-medium text-fg/35">4.1k</span>
          </span>
          <span className="font-medium text-violet-300/35">$0.03</span>
        </div>
      </div>
    </div>
  );
}

function PreviewShellHeader({ provider }: { provider: PreviewProviderKey }) {
  const { name, Logo } = PREVIEW_PROVIDER_META[provider];
  return (
    <div className={CHAT_SHELL_HEADER_CLASS}>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 shrink items-center gap-1.5">
          <Logo size={16} className="shrink-0 opacity-90" />
          <span className="min-w-0 shrink truncate font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-bold tracking-tight text-fg/90">
            {name}
          </span>
        </div>
      </div>
    </div>
  );
}

function PreviewColumn({
  provider,
  accentColor,
  shellGeometry,
  chromeTint,
  children,
}: {
  provider: PreviewProviderKey;
  accentColor: string;
  shellGeometry: ChatShellGeometry;
  chromeTint: ChatChromeTint;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <ChatSurfaceShell
        mode="standard"
        accentColor={accentColor}
        chromeTint={chromeTint}
        shellGeometry={shellGeometry}
        autoHeight
        header={<PreviewShellHeader provider={provider} />}
        className={cn(
          "w-full min-w-0 border border-white/[0.06] shadow-[var(--chat-shell-shadow)]",
          "rounded-[var(--chat-radius-shell)]",
        )}
      >
        {children}
      </ChatSurfaceShell>
    </div>
  );
}

/** Identical transcript in each preview column: user prompt, markdown reply, tool/file rows, real-style usage row. */
/** Static stand-in for the live ChatUserMinimap rail (dots = user turns), so the
 *  appearance toggle has something to reflect without the real scroll/store wiring. */
function PreviewMinimapRail() {
  return (
    <div className="pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-1.5">
      {[0, 1].map((i) => (
        <span
          key={i}
          className={cn(
            "h-2 w-[3px] rounded-full",
            i === 1 ? "bg-[color:var(--color-accent,#A78BFA)]/80" : "bg-fg/25",
          )}
        />
      ))}
    </div>
  );
}

function SharedAppearanceTranscript({
  rootStyle,
  provider,
  chromeTint,
  chatUserMinimapEnabled,
}: {
  rootStyle: React.CSSProperties;
  provider: PreviewProviderKey;
  chromeTint: ChatChromeTint;
  chatUserMinimapEnabled?: boolean;
}) {
  const neu = chromeTint === "neutral";
  return (
    <div data-chat-appearance-root style={rootStyle} className={cn(transcriptPaneClass, "relative")}>
      {chatUserMinimapEnabled ? <PreviewMinimapRail /> : null}
      <div className="flex min-w-0 w-full justify-end">
        <div
          className={cn(
            CHAT_TRANSCRIPT_GLASS_CARD_CLASS,
            "ade-chat-message-card-user group relative min-w-0 max-w-[min(100%,92%)] px-[length:var(--chat-bubble-user-px)] py-[length:var(--chat-bubble-user-py)]",
          )}
          style={CHAT_USER_MESSAGE_CARD_STYLE}
        >
          <div className="whitespace-pre-wrap break-words text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.65] text-white">
            {SAMPLE_USER_PROMPT}
          </div>
          <div className="mt-1 font-mono text-[length:calc(var(--chat-font-size)*8/14)] text-fg/35">12:02</div>
        </div>
      </div>

      {/* Assistant text is unbubbled — matches the real chat (AgentChatMessageList):
          bare markdown on the canvas, no card / accent line. */}
      <div className="flex min-w-0 max-w-full w-full justify-start overflow-hidden">
        <div className="group relative min-w-0 max-w-full overflow-visible py-0.5 pr-7 text-[length:var(--chat-font-size)] leading-[1.7]">
          <div className="min-w-0 max-w-full">
            <ChatMarkdown tone={neu ? "neutral" : "sky"}>{SAMPLE_ASSISTANT_MARKDOWN}</ChatMarkdown>
          </div>
        </div>
      </div>

      {/* Same wrapper as `AgentChatMessageList` work_log_group rows — no extra work-card chrome. */}
      <div className="flex min-w-0 w-full justify-start">
        <div className="min-w-0 w-fit max-w-full sm:max-w-[min(100%,70ch)]">
          <ChatWorkLogBlock entries={PREVIEW_WORK_LOG_ENTRIES} animate={false} />
        </div>
      </div>

      <PreviewUsageRow provider={provider} />

      <div className="flex min-w-0 w-full justify-end">
        <div
          className={cn(
            CHAT_TRANSCRIPT_GLASS_CARD_CLASS,
            "ade-chat-message-card-user group relative min-w-0 max-w-[min(100%,92%)] px-[length:var(--chat-bubble-user-px)] py-[length:var(--chat-bubble-user-py)]",
          )}
          style={CHAT_USER_MESSAGE_CARD_STYLE}
        >
          <div className="whitespace-pre-wrap break-words text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.65] text-white">
            {SAMPLE_USER_FOLLOWUP}
          </div>
          <div className="mt-1 font-mono text-[length:calc(var(--chat-font-size)*8/14)] text-fg/35">12:06</div>
        </div>
      </div>
    </div>
  );
}

const PREVIEW_COLUMNS: ReadonlyArray<{ provider: PreviewProviderKey; fallbackAccent: string }> = [
  { provider: "codex", fallbackAccent: "#E7E5E4" },
  { provider: "claude", fallbackAccent: "#D97706" },
  { provider: "opencode", fallbackAccent: "#2563EB" },
  { provider: "cursor", fallbackAccent: "#A78BFA" },
  { provider: "droid", fallbackAccent: "#8B5CF6" },
];

export function ChatAppearancePreview({
  theme,
  chatFontSizePx,
  transcriptDensity,
  chromeTint,
  shellGeometry,
  chatUserMinimapEnabled = false,
}: ChatAppearancePreviewProps) {
  const rootStyle = buildChatAppearanceRootStyle({
    chatFontSizePx,
    transcriptDensity,
  });

  return (
    <div
      data-theme={theme}
      // 5 runtimes: 1-up on narrow, 2-up at lg, 3-up at xl (5 wraps cleanly; forcing
      // 5 across would make each column unreadably narrow).
      className="grid w-full min-w-0 grid-cols-1 items-start gap-3 lg:grid-cols-[repeat(2,minmax(0,1fr))] xl:grid-cols-[repeat(3,minmax(0,1fr))]"
    >
      {PREVIEW_COLUMNS.map(({ provider, fallbackAccent }) => (
        <PreviewColumn
          key={provider}
          provider={provider}
          accentColor={providerChatAccent(provider) ?? fallbackAccent}
          shellGeometry={shellGeometry}
          chromeTint={chromeTint}
        >
          <SharedAppearanceTranscript
            rootStyle={rootStyle}
            provider={provider}
            chromeTint={chromeTint}
            chatUserMinimapEnabled={chatUserMinimapEnabled}
          />
        </PreviewColumn>
      ))}
    </div>
  );
}
