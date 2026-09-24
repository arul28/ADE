/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../shared/types/chat";
import type { ExternalSessionHome } from "../../../../shared/types/externalSessions";
import type { ExternalSessionSource, ExternalSessionSummary } from "./contract";
import { getDefaultModelDescriptor, resolveModelDescriptor } from "../../../../shared/modelRegistry";
import { DEFAULT_FORK_MODEL, ImportSessionBrowser } from "./ImportSessionBrowser";

const CLAUDE_DEFAULT_MODEL = getDefaultModelDescriptor("claude")?.id ?? "";
const list = vi.fn();
const importSession = vi.fn();
const getDetail = vi.fn();
const watchDetail = vi.fn();
const unwatchDetail = vi.fn();

vi.mock("../../lanes/LaneDialogShell", () => ({
  LaneDialogShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ToolLogos", () => ({
  ToolLogo: () => <span data-testid="tool-logo" />,
}));
vi.mock("../../ui/SmartTooltip", () => ({
  SmartTooltip: ({ children, content }: { children: React.ReactNode; content: { label: string; description: string } }) => (
    <span data-tooltip-label={content.label} data-tooltip-description={content.description}>{children}</span>
  ),
}));
vi.mock("../../shared/ModelPicker/ModelPicker", () => ({
  ModelPicker: ({ value }: { value: string }) => <div data-testid="model-picker">{value}</div>,
}));
vi.mock("../../chat/AgentChatMessageList", () => ({
  AgentChatMessageList: (props: {
    events: AgentChatEventEnvelope[];
    sessionId: string;
    sessionEnded?: boolean;
    textPacingEnabled?: boolean;
    hasOlderHistory?: boolean;
    onLoadOlderHistory?: () => void;
  }) => (
    <div
      data-testid="transcript"
      data-session-id={props.sessionId}
      data-ended={String(props.sessionEnded)}
      data-pacing={String(props.textPacingEnabled)}
    >
      {props.hasOlderHistory ? <button type="button" onClick={props.onLoadOlderHistory}>Load older</button> : null}
      {props.events.map((envelope, index) => (
        <p key={index}>{(envelope.event as { text?: string }).text}</p>
      ))}
    </div>
  ),
}));
vi.mock("../LaneCombobox", () => ({
  LaneCombobox: (props: {
    lanes: Array<{ id: string; name: string; detail?: string | null }>;
    value: string;
    onChange: (id: string) => void;
    showAllOption?: boolean;
    allLabel?: string;
    allDetail?: string | null;
    "aria-label"?: string;
  }) => (
    <select aria-label={props["aria-label"]} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.showAllOption ? (
        <option value="all">{`${props.allLabel ?? "All lanes"}${props.allDetail ? ` (${props.allDetail})` : ""}`}</option>
      ) : null}
      {props.lanes.map((lane) => (
        <option key={lane.id} value={lane.id}>{`${lane.name}${lane.detail ? ` (${lane.detail})` : ""}`}</option>
      ))}
    </select>
  ),
  computeLanePopoverPlacement: () => ({ width: 220, left: 0, top: 0, maxHeight: 320, openAbove: false }),
}));

const LANES = [
  { id: "lane-1", name: "Lane One", color: "#ff0000", branchRef: "refs/heads/ade/one", laneType: "worktree" },
  { id: "lane-2", name: "Lane Two", color: "#00ff00", branchRef: "refs/heads/ade/two", laneType: "worktree" },
  { id: "lane-3", name: "Lane Three", color: null, branchRef: "refs/heads/ade/three", laneType: "worktree" },
];

function home(laneId: string, overrides: Partial<ExternalSessionHome> = {}): ExternalSessionHome {
  const lane = LANES.find((candidate) => candidate.id === laneId);
  return {
    kind: "lane",
    laneId,
    laneName: lane?.name ?? laneId,
    branchRef: lane?.branchRef ?? null,
    color: lane?.color ?? null,
    laneType: "worktree",
    atLaneRoot: true,
    ...overrides,
  };
}

function summary(overrides: Partial<ExternalSessionSummary> = {}): ExternalSessionSummary {
  return {
    provider: "claude",
    id: "s1",
    cwd: "/Users/dev/project/.ade/worktrees/lane-one-abc123",
    title: "Fix login",
    preview: "please fix login",
    createdAt: Date.parse("2026-08-14T12:00:00.000Z"),
    updatedAt: Date.parse("2026-08-14T12:00:00.000Z"),
    messageCount: 4,
    alreadyImported: false,
    possiblyActive: false,
    cwdMatchesRequestedLane: true,
    capabilities: {
      resumeInPlace: true,
      resumeInDifferentCwd: false,
      fork: true,
      forkIntoDifferentCwd: true,
      importToChat: true,
    },
    home: home("lane-1"),
    ...overrides,
  };
}

function envelope(type: "user_message" | "text", text: string, index: number): AgentChatEventEnvelope {
  return {
    sessionId: "preview",
    timestamp: new Date(1_000 + index).toISOString(),
    event: type === "user_message" ? { type, text } : { type, text },
  };
}

function detailFor(s: ExternalSessionSummary, extra: Record<string, unknown> = {}) {
  return {
    provider: s.provider,
    id: s.id,
    cwd: s.cwd,
    title: s.title,
    model: "anthropic/claude-sonnet-5",
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messageCount,
    messages: [],
    sourcePath: null,
    watchable: true,
    events: [envelope("user_message", `${s.title} prompt`, 0), envelope("text", `${s.title} reply`, 1)],
    hasOlder: false,
    olderCursor: null,
    ...extra,
  };
}

/** Lists `rows` only for the matching provider, like the per-provider scan. */
function listRows(rows: ExternalSessionSummary[]) {
  list.mockImplementation(async (args: { providers?: string[] }) => (
    rows.filter((row) => args.providers?.includes(row.provider))
  ));
  watchDetail.mockImplementation(async (args: { sessionId: string }) => {
    const row = rows.find((candidate) => candidate.id === args.sessionId) ?? rows[0]!;
    return detailFor(row);
  });
}

function renderBrowser(props: Partial<React.ComponentProps<typeof ImportSessionBrowser>> = {}) {
  const onImported = vi.fn();
  const onOpenChange = vi.fn();
  const utils = render(
    <ImportSessionBrowser
      open
      onOpenChange={onOpenChange}
      laneId="lane-1"
      laneName="Lane One"
      lanes={LANES}
      onImported={onImported}
      {...props}
    />,
  );
  return { ...utils, onImported, onOpenChange };
}

/** The list row whose title is `title`, or null. */
function rowEl(title: string): HTMLElement | null {
  const listbox = screen.queryByRole("listbox", { name: "Sessions" });
  if (!listbox) return null;
  const match = within(listbox).queryAllByText(title).find((el) => el.closest("[data-import-row]"));
  return (match?.closest("[data-import-row]") as HTMLElement | null) ?? null;
}

function actionBar() {
  return screen.getByRole("region", { name: "Session conversation" }).parentElement!.querySelector("footer")!;
}

describe("ImportSessionBrowser", () => {
  beforeEach(() => {
    list.mockReset();
    importSession.mockReset();
    getDetail.mockReset();
    watchDetail.mockReset();
    unwatchDetail.mockReset();
    unwatchDetail.mockResolvedValue({ ok: true });
    importSession.mockResolvedValue({ kind: "chat", chatSessionId: "ade-chat", laneId: "lane-1", chatSummary: null });
    window.localStorage.clear();
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        externalSessions: {
          list,
          import: importSession,
          getDetail,
          watchDetail,
          unwatchDetail,
          onDetailUpdated: () => () => undefined,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as { ade?: unknown }).ade;
  });

  it("scans every provider and shows skeleton rows while scanning", async () => {
    list.mockImplementation(() => new Promise<ExternalSessionSummary[]>(() => undefined));
    renderBrowser();
    expect((await screen.findByRole("status")).textContent).toContain("Scanning");
    expect(list).toHaveBeenCalledTimes(10);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ scope: "project", providers: ["qwen"] }));
  });

  it("scans once more on its own, then explains a full scan failure and retries", async () => {
    list.mockRejectedValue(new Error("Project runtime unavailable."));
    renderBrowser();
    // A host that is still starting fails every provider; the dialog waits and
    // scans again (10 providers x 2) before it shows the error.
    await waitFor(() => expect(screen.getByText("Sessions couldn't be loaded")).toBeTruthy(), { timeout: 6000 });
    expect(list).toHaveBeenCalledTimes(20);
    expect(screen.getByText(/ADE couldn't scan sessions on This computer/i)).toBeTruthy();
    expect(screen.queryByText(/Project runtime unavailable/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Retry scan/ }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(40), { timeout: 6000 });
  }, 15_000);

  it("recovers without an error when the host answers on the automatic second scan", async () => {
    const rows = [summary({ id: "a", title: "Alpha" })];
    let calls = 0;
    list.mockImplementation(async (args: { providers?: string[] }) => {
      calls += 1;
      if (calls <= 10) throw new Error("Project runtime unavailable.");
      return rows.filter((row) => args.providers?.includes(row.provider));
    });
    watchDetail.mockImplementation(async () => detailFor(rows[0]!));
    renderBrowser();
    await waitFor(() => expect(rowEl("Alpha")).toBeTruthy(), { timeout: 6000 });
    expect(screen.queryByText("Sessions couldn't be loaded")).toBeNull();
  }, 15_000);

  it("says so when no provider has a session", async () => {
    listRows([]);
    renderBrowser();
    await waitFor(() => expect(screen.getByText("No sessions found")).toBeTruthy());
    expect(screen.getByText(/Checked Claude, Codex, .*Copilot on This computer/)).toBeTruthy();
  });

  it("opens on the dialog's lane with per-lane counts and an Other folders entry", async () => {
    listRows([
      summary({ id: "a", title: "Alpha" }),
      summary({ id: "b", provider: "codex", title: "Bravo" }),
      summary({ id: "c", title: "Charlie", home: home("lane-2") }),
      summary({ id: "d", title: "Delta", cwd: "/Users/dev/project/scripts", home: { ...home("lane-1"), kind: "outside", laneId: null, laneName: null } }),
      summary({ id: "e", title: "Empty", messageCount: 0 }),
    ]);
    renderBrowser();
    await waitFor(() => expect(rowEl("Bravo")).toBeTruthy());

    const laneFilter = screen.getByRole("combobox", { name: "Filter by lane" }) as HTMLSelectElement;
    expect(laneFilter.value).toBe("lane-1");
    const options = Array.from(laneFilter.options).map((option) => option.textContent);
    expect(options).toEqual(["All lanes (4)", "Lane One (2)", "Lane Two (1)", "Other folders (1)"]);
    expect(rowEl("Alpha")).toBeTruthy();
    expect(rowEl("Charlie")).toBeNull();
    expect(rowEl("Empty")).toBeNull();

    // Provider chips only for providers that returned sessions, counted in this lane.
    const chips = screen.getByRole("group", { name: "Provider" });
    expect(within(chips).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["All2", "Claude1", "Codex1"]);

    fireEvent.change(laneFilter, { target: { value: "__ade_import_other_folders__" } });
    expect(rowEl("Delta")).toBeTruthy();
    expect(rowEl("Alpha")).toBeNull();
  });

  it("defaults to All lanes when the dialog's lane has no sessions", async () => {
    listRows([summary({ id: "c", title: "Charlie", home: home("lane-2") })]);
    renderBrowser({ laneId: "lane-3", laneName: "Lane Three" });
    await waitFor(() => expect(rowEl("Charlie")).toBeTruthy());
    expect((screen.getByRole("combobox", { name: "Filter by lane" }) as HTMLSelectElement).value).toBe("all");
  });

  it("names the lane on each row instead of the worktree folder", async () => {
    listRows([
      summary({ id: "a", title: "Alpha", updatedAt: Date.parse("2026-08-14T12:00:00.000Z") }),
      summary({ id: "r", title: "Removed", home: { ...home("lane-1"), kind: "removed-lane", laneId: null, laneName: null } }),
    ]);
    renderBrowser({ laneId: "lane-9" });
    await waitFor(() => expect(rowEl("Alpha")).toBeTruthy());
    const row = rowEl("Alpha") as HTMLElement;
    expect(row.textContent).toContain("Lane One");
    expect(row.textContent).toContain("4 prompts");
    expect(row.textContent).not.toContain("worktrees");
    expect((rowEl("Removed") as HTMLElement).textContent).toContain("Removed lane");
  });

  it("previews the first row through the chat transcript, read-only", async () => {
    listRows([summary({ id: "a", title: "Alpha" })]);
    renderBrowser();
    await waitFor(() => expect(screen.getByText("Alpha prompt")).toBeTruthy());
    const transcript = screen.getByTestId("transcript");
    expect(transcript.dataset.sessionId).toBe("external-preview:claude:a");
    expect(transcript.dataset.ended).toBe("true");
    expect(transcript.dataset.pacing).toBe("false");
    expect(screen.getByText("Alpha reply")).toBeTruthy();
    expect(watchDetail).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude", sessionId: "a" }));
  });

  it("falls back to plain messages when the host sends no events", async () => {
    listRows([summary({ id: "a", title: "Alpha" })]);
    watchDetail.mockResolvedValue(detailFor(summary({ id: "a" }), {
      events: undefined,
      messages: [{ role: "user", text: "old host prompt", at: 1 }, { role: "assistant", text: "old host reply", at: 2 }],
    }));
    renderBrowser();
    await waitFor(() => expect(screen.getByText("old host reply")).toBeTruthy());
  });

  it("pages older events in front of the loaded ones", async () => {
    const row = summary({ id: "a", title: "Alpha" });
    listRows([row]);
    watchDetail.mockResolvedValue(detailFor(row, { hasOlder: true, olderCursor: "cursor-1" }));
    getDetail.mockResolvedValue(detailFor(row, {
      events: [envelope("user_message", "earliest prompt", 0)],
      hasOlder: false,
      olderCursor: null,
    }));
    renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    await waitFor(() => expect(screen.getByText("earliest prompt")).toBeTruthy());
    expect(getDetail).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude", sessionId: "a", before: "cursor-1" }),
      null,
    );
    const texts = Array.from(screen.getByTestId("transcript").querySelectorAll("p")).map((p) => p.textContent);
    expect(texts).toEqual(["earliest prompt", "Alpha prompt", "Alpha reply"]);
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("locks the lane pill with the policy's reason when the mode cannot leave home", async () => {
    listRows([summary({ id: "cur", provider: "cursor", title: "Cursor run" })]);
    renderBrowser();
    await waitFor(() => expect(screen.getByText("Cursor run prompt")).toBeTruthy());

    // Chat: Cursor only copies, to any lane.
    expect(within(actionBar()).getByRole("button", { name: /Open as ADE chat/ })).toBeTruthy();
    expect(within(actionBar()).getByRole("combobox", { name: "Import into lane" })).toBeTruthy();
    expect(within(actionBar()).getByTestId("model-picker")).toBeTruthy();

    // CLI: continue only, in its own lane.
    fireEvent.click(within(actionBar()).getByRole("radio", { name: "CLI" }));
    const locked = within(actionBar()).getByTestId("import-locked-lane");
    expect(locked.textContent).toContain("Lane One");
    expect(locked.parentElement?.dataset.tooltipDescription).toBe("Cursor sessions stay in their own lane.");
    expect(within(actionBar()).queryByRole("combobox", { name: "Import into lane" })).toBeNull();
    expect(within(actionBar()).queryByTestId("model-picker")).toBeNull();
    expect(within(actionBar()).getByRole("button", { name: /Continue/ })).toBeTruthy();
  });

  it("shows a single mode as a label, not a one-option switch", async () => {
    listRows([summary({
      id: "k",
      provider: "kimi",
      title: "Kimi run",
      capabilities: { resumeInPlace: false, resumeInDifferentCwd: false, fork: false, forkIntoDifferentCwd: false, importToChat: false },
    })]);
    renderBrowser();
    await waitFor(() => expect(screen.getByText("Kimi run prompt")).toBeTruthy());
    expect(within(actionBar()).queryByRole("radiogroup")).toBeNull();
    expect(within(actionBar()).getByText("ADE chat")).toBeTruthy();
  });

  it("targets the session's home lane and ignores the Work lane changing", async () => {
    const row = summary({ id: "c", title: "Charlie", home: home("lane-2") });
    listRows([row]);
    const { rerender, onImported, onOpenChange } = renderBrowser({ laneId: "lane-1" });
    await waitFor(() => expect(screen.getByText("Charlie prompt")).toBeTruthy());
    const target = () => within(actionBar()).getByRole("combobox", { name: "Import into lane" }) as HTMLSelectElement;
    expect(target().value).toBe("lane-2");

    rerender(
      <ImportSessionBrowser
        open
        onOpenChange={onOpenChange}
        laneId="lane-3"
        laneName="Lane Three"
        lanes={LANES}
        onImported={onImported}
      />,
    );
    expect(target().value).toBe("lane-2");

    fireEvent.click(within(actionBar()).getByRole("button", { name: /^Continue/ }));
    await waitFor(() => expect(importSession).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "lane-2", target: "chat", mode: "resume" }),
    ));
  });

  it("runs the main action on Enter and closes", async () => {
    const row = summary({ id: "a", title: "Alpha" });
    listRows([row]);
    const { onImported, onOpenChange } = renderBrowser();
    await waitFor(() => expect(screen.getByText("Alpha prompt")).toBeTruthy());
    fireEvent.keyDown(rowEl("Alpha")!, { key: "Enter" });
    await waitFor(() => expect(importSession).toHaveBeenCalledWith({
      provider: "claude",
      sessionId: "a",
      laneId: "lane-1",
      target: "chat",
      mode: "resume",
    }));
    expect(onImported).toHaveBeenCalledWith(row, expect.anything(), expect.objectContaining({ machineId: expect.any(String) }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not import the auto-selected row when Enter is pressed right after opening", async () => {
    listRows([summary({ id: "a", title: "Alpha" })]);
    renderBrowser();
    await waitFor(() => expect(screen.getByText("Alpha prompt")).toBeTruthy());
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search sessions" }), { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(importSession).not.toHaveBeenCalled();
  });

  it("asks for the model before a chat copy and copies on the second click", async () => {
    listRows([summary({ id: "a", title: "Alpha" })]);
    renderBrowser();
    await waitFor(() => expect(screen.getByText("Alpha prompt")).toBeTruthy());
    expect(screen.queryByTestId("import-model")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByTestId("import-model")).toBeTruthy();
    expect(importSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Make copy/ }));
    await waitFor(() => expect(importSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      sessionId: "a",
      target: "chat",
      mode: "fork",
    })));
  });

  it("moves the selection with the arrow keys and the preview follows", async () => {
    listRows([
      summary({ id: "a", title: "Alpha", updatedAt: 2_000 }),
      summary({ id: "b", title: "Bravo", updatedAt: 1_000 }),
    ]);
    renderBrowser();
    await waitFor(() => expect(screen.getByText("Alpha prompt")).toBeTruthy());
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search sessions" }), { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByText("Bravo prompt")).toBeTruthy());
    expect(rowEl("Bravo")?.getAttribute("aria-selected")).toBe("true");
  });

  it("asks for a second click before continuing a live session", async () => {
    listRows([summary({ id: "a", title: "Alpha", possiblyActive: true })]);
    renderBrowser();
    await waitFor(() => expect(screen.getByText("Alpha prompt")).toBeTruthy());
    expect(within(actionBar()).getByText("Open elsewhere — close it there first.")).toBeTruthy();

    fireEvent.click(within(actionBar()).getByRole("button", { name: /^Continue/ }));
    expect(importSession).not.toHaveBeenCalled();
    fireEvent.click(within(actionBar()).getByRole("button", { name: /Continue anyway/ }));
    await waitFor(() => expect(importSession).toHaveBeenCalledWith(expect.objectContaining({ mode: "resume" })));
  });

  it("remembers the chosen mode per provider", async () => {
    listRows([summary({ id: "a", title: "Alpha" })]);
    renderBrowser();
    await waitFor(() => expect(screen.getByText("Alpha prompt")).toBeTruthy());
    fireEvent.click(within(actionBar()).getByRole("radio", { name: "CLI" }));
    expect(window.localStorage.getItem("ade.importSession.surface.claude")).toBe("cli");
    cleanup();

    renderBrowser();
    await waitFor(() => expect(screen.getByText("Alpha prompt")).toBeTruthy());
    expect(within(actionBar()).getByRole("radio", { name: "CLI" }).getAttribute("aria-checked")).toBe("true");
  });

  it("sends the chosen model with a chat copy and falls back from unknown models", async () => {
    listRows([summary({
      id: "a",
      title: "Alpha",
      launch: { model: "totally-not-a-registry-model" },
      home: home("lane-1", { atLaneRoot: false }),
    })]);
    renderBrowser();
    await waitFor(() => expect(screen.getByText("Alpha prompt")).toBeTruthy());
    expect(within(actionBar()).getByTestId("model-picker").textContent).toBe(CLAUDE_DEFAULT_MODEL);
    fireEvent.click(within(actionBar()).getByRole("button", { name: /Open as ADE chat/ }));
    await waitFor(() => expect(importSession).toHaveBeenCalledWith(expect.objectContaining({
      target: "chat",
      mode: "fork",
      model: CLAUDE_DEFAULT_MODEL,
    })));
  });

  it("keeps the default fork model resolvable through the shared registry", () => {
    expect(resolveModelDescriptor(DEFAULT_FORK_MODEL)).toBeTruthy();
  });

  it("offers Open in ADE for a session that is already imported", async () => {
    listRows([summary({
      id: "a",
      title: "Alpha",
      alreadyImported: true,
      importedSessionRef: { kind: "chat", sessionId: "ade-1" },
    })]);
    const onOpenExisting = vi.fn();
    renderBrowser({ onOpenExisting });
    await waitFor(() => expect(screen.getByText("Alpha prompt")).toBeTruthy());
    fireEvent.click(within(actionBar()).getByRole("button", { name: /Open in ADE/ }));
    expect(onOpenExisting).toHaveBeenCalledWith({ kind: "chat", sessionId: "ade-1" }, expect.anything());
    expect(importSession).not.toHaveBeenCalled();
  });

  it("hides provider chips with no session in the chosen lane", async () => {
    listRows([
      summary({ id: "a", title: "Alpha" }),
      summary({ id: "b", provider: "codex", title: "Bravo", home: home("lane-2") }),
    ]);
    renderBrowser();
    await waitFor(() => expect(rowEl("Alpha")).toBeTruthy());
    const chips = within(screen.getByRole("group", { name: "Provider" }));
    expect(chips.queryByRole("button", { name: /Codex/ })).toBeNull();
    expect(chips.getByRole("button", { name: /Claude/ })).toBeTruthy();
  });

  it("offers search matches from other lanes when the chosen lane has none", async () => {
    listRows([
      summary({ id: "a", title: "Alpha" }),
      summary({ id: "b", provider: "codex", title: "Bravo", home: home("lane-2") }),
    ]);
    renderBrowser();
    await waitFor(() => expect(rowEl("Alpha")).toBeTruthy());
    fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "Bravo" } });
    expect(screen.getByText("No matches in Lane One")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 in other lanes" }));
    expect(rowEl("Bravo")).toBeTruthy();
    expect(rowEl("Alpha")).toBeNull();
  });

  it("switches the scan and import route to a connected computer", async () => {
    const studioBinding = {
      kind: "remote" as const,
      key: "studio-project",
      targetId: "studio",
      runtimeName: "Mac Studio",
      projectId: "project-1",
      rootPath: "/Users/dev/project",
      displayName: "ADE",
    };
    const local = summary({ id: "local-session", title: "Local chat", home: home("local-lane") });
    const studio = summary({
      id: "studio-session",
      title: "Studio chat",
      home: { ...home("studio-lane"), laneName: "Primary" },
    });
    list.mockImplementation(async (args: { laneId?: string; providers?: string[] }) => (
      args.providers?.includes("claude") ? (args.laneId === "studio-lane" ? [studio] : [local]) : []
    ));
    watchDetail.mockResolvedValue(detailFor(local));
    getDetail.mockResolvedValue(detailFor(studio));
    importSession.mockResolvedValue({ kind: "chat", chatSessionId: "ade-chat-studio", laneId: "studio-lane", chatSummary: null });
    const sources: ExternalSessionSource[] = [
      {
        machineId: "this-mac",
        machineName: "This computer",
        lanes: [{ id: "local-lane", name: "Primary", laneType: "primary" }],
        binding: null,
        runtimePin: null,
        online: true,
      },
      {
        machineId: "studio",
        machineName: "Mac Studio",
        lanes: [{ id: "studio-lane", name: "Primary", laneType: "primary" }],
        binding: studioBinding,
        runtimePin: studioBinding,
        online: true,
      },
    ];
    const { onImported } = renderBrowser({ laneId: "local-lane", laneName: "Primary", sources });

    await waitFor(() => expect(rowEl("Local chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Choose import source/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Mac Studio" }));

    await waitFor(() => expect(screen.getByText("Studio chat prompt")).toBeTruthy());
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ laneId: "studio-lane" }), studioBinding);
    expect(rowEl("Local chat")).toBeNull();
    expect(getDetail).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "studio-session" }), studioBinding);

    await act(async () => {
      fireEvent.click(within(actionBar()).getByRole("button", { name: /^Continue/ }));
    });
    await waitFor(() => expect(importSession).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "studio-lane" }),
      studioBinding,
    ));
    expect(onImported).toHaveBeenCalledWith(studio, expect.anything(), expect.objectContaining({ machineId: "studio" }));
  });
});
