import type { ProviderContextItemKind, ProviderContextTiming } from "../../../shared/types/providerContext";

/**
 * The text ADE itself sends a new lane chat of one provider, built by the same
 * builders the launch uses (`agentChatService.previewNewChatAdeContext`). A
 * provider page's Initial context window (`ai/providerContextInventory.ts`)
 * turns it into items with sizes. Nothing here is sent anywhere; it is a dry
 * render.
 */
export type AdeChatContextPart = {
  /** Stable id: `ade-prompt`, `ade-cli-guidance`, `ade-project-notes`, ... */
  id: string;
  label: string;
  kind: ProviderContextItemKind;
  timing: ProviderContextTiming;
  /** The exact text. */
  text: string;
  source?: string | null;
  detail?: string | null;
  /**
   * Ids of other parts whose text is inside this one's (the CLI guidance is
   * inside the system prompt). The list shows them as their own items, so
   * this part's own size is its text minus theirs.
   */
  includes?: string[];
  /** For a listing: one entry per listed skill or command, with its line. */
  entries?: ReadonlyArray<{ name: string; text: string; source?: string | null }>;
};

export type AdeChatContextPreview = {
  provider: string;
  laneId: string | null;
  /** The folder a new chat in that lane runs in. */
  laneWorktreePath: string;
  parts: AdeChatContextPart[];
  /** ADE's skill roots for that folder, as the launch names them. */
  adeSkillRoots: string[];
  /** The ADE MCP registry servers this provider would be handed: names and transport only. */
  mcpServers: Array<{ name: string; type: string }>;
  /**
   * The provider config-home variables a new chat launches with
   * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...). Paths only, never a credential.
   * Empty when the chat inherits the machine's own config home.
   */
  providerHomeEnv: Record<string, string>;
};

/** The text ADE puts in a provider's own prompt slot (system prompt, developer instructions, first message). */
export type AdeChatMainText = {
  label: string;
  timing: ProviderContextTiming;
  detail: string;
  text: string;
};

/**
 * Splits what one new chat gets from ADE into parts. The CLI guidance, status
 * reporting, skill listing and project notes are listed on their own when the
 * main text holds them, and the main part's `includes` names them, so its own
 * size can leave them out. The directives that ride the first message follow.
 */
export function assembleAdeChatContextParts(input: {
  main: AdeChatMainText;
  cliGuidance: string | null;
  activity: string | null;
  listing: { text: string; entries: NonNullable<AdeChatContextPart["entries"]> } | null;
  projectNotes: string | null;
  perTurn: string | null;
  launchDirective: string | null;
  computerUse: string | null;
  laneScreen: string | null;
  appleDevice: string | null;
}): AdeChatContextPart[] {
  const { main } = input;
  const inMain = (text: string | null | undefined): text is string => Boolean(text?.trim() && main.text.includes(text.trim()));
  const inner: AdeChatContextPart[] = [];
  if (inMain(input.cliGuidance)) {
    inner.push({
      id: "ade-cli-guidance",
      label: "ADE CLI guidance",
      kind: "instructions",
      timing: main.timing,
      text: input.cliGuidance.trim(),
      detail: "How to use the `ade` command and where ADE's skills are.",
    });
  }
  if (inMain(input.activity)) {
    inner.push({
      id: "ade-activity",
      label: "ADE status reporting",
      kind: "instructions",
      timing: main.timing,
      text: input.activity.trim(),
      detail: "How the agent reports its status to the Work board.",
    });
  }
  if (input.listing && inMain(input.listing.text)) {
    inner.push({
      id: "ade-skill-listing",
      label: "ADE skill listing",
      kind: "skills",
      timing: main.timing,
      text: input.listing.text,
      detail: "Skills and commands the provider cannot find by itself, with their files.",
      entries: input.listing.entries,
    });
  }
  if (inMain(input.projectNotes)) {
    inner.push({
      id: "ade-project-notes",
      label: "Project notes",
      kind: "notes",
      timing: main.timing,
      text: input.projectNotes.trim(),
      detail: "The notes saved for this project in ADE.",
    });
  }
  const parts: AdeChatContextPart[] = [];
  if (main.text.trim()) {
    parts.push({
      id: "ade-prompt",
      label: main.label,
      kind: "system-prompt",
      timing: main.timing,
      text: main.text.trim(),
      detail: main.detail,
      includes: inner.map((part) => part.id),
    });
  }
  parts.push(...inner);
  const directive = (id: string, label: string, text: string | null, timing: ProviderContextTiming, detail?: string) => {
    if (text?.trim()) parts.push({ id, label, kind: "instructions", timing, text, ...(detail ? { detail } : {}) });
  };
  directive("ade-turn-directive", "ADE turn directive", input.perTurn?.trim() ?? null, "every-request", "Put before every message: ADE's plan and question controls.");
  directive("ade-launch-directive", "ADE launch directive", input.launchDirective, "chat-start", "Names the lane and its folder, on the first message.");
  directive("ade-computer-use", "ADE computer-use rules", input.computerUse, "chat-start", "Screen, browser and proof rules, on the first message.");
  directive("ade-lane-screen", "ADE lane screen", input.laneScreen, "chat-start");
  directive("ade-apple-device", "ADE Apple device", input.appleDevice, "chat-start");
  return parts;
}
