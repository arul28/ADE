/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope, OpenProjectBinding } from "../../../../shared/types";
import {
  DRAFT_LAUNCH_JOB_STALE_AFTER_MS,
  type DraftLaunchKind,
  type DraftLaunchMode,
  type DraftLaunchSnapshot,
  type NativeControlState,
  type PreparedDraftLaunch,
} from "../../../lib/draftLaunchJobs";
import { getAppResourceUsageCoalesced, latestAppResourcePressureLevel } from "../../../lib/resourcePressure";
import type { ComposerHandoff } from "./chatLaunchDock";
import {
  clearSubmittedDraftText,
  removeSubmittedDraftItems,
  removeSubmittedDraftItemsById,
  runRendererOwnedLaunch,
  sameStoredDraftItem,
  stashRendererLaunchHandoff,
  takeRendererLaunchHandoff,
  type RendererOwnedLaunchDeps,
} from "./rendererOwnedLaunch";

import {
  findComposerHandoffElement,
  findDraftComposerHandoffElement,
  hasPendingComposerDock,
  peekComposerHandoffFirstMessage,
  playComposerDock,
  playDepartingDraftChrome,
  playFirstMessageFlight,
  refreshComposerHandoffDeparture,
  stashComposerDockOrigin,
  takeComposerDockOrigin,
} from "./chatLaunchDock";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function withRect<T extends HTMLElement>(element: T, value: DOMRect): T {
  element.getBoundingClientRect = () => value;
  return element;
}

function draftComposer(): HTMLElement {
  const wrapper = withRect(document.createElement("div"), rect(100, 400, 600, 120));
  const text = withRect(document.createElement("div"), rect(110, 410, 580, 40));
  text.setAttribute("data-chat-composer-text", "");
  text.style.paddingLeft = "16px";
  text.style.paddingTop = "10px";
  wrapper.appendChild(text);
  document.body.appendChild(wrapper);
  return wrapper;
}

function firstMessage(sessionId: string): AgentChatEventEnvelope {
  return {
    sessionId,
    timestamp: "2026-09-23T00:00:00.000Z",
    event: { type: "user_message", text: "fix the flaky test" },
  };
}

const launchSnapshot = {
  text: "fix the flaky test",
  draft: "fix the flaky test",
  modelId: "openai/gpt-5.4",
  reasoningEffort: null,
  fastMode: false,
  cursorCloudServiceTier: null,
  executionMode: "focused",
  interactionMode: "default",
  nativeControls: {
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    opencodePermissionMode: "edit",
    droidPermissionMode: "auto-low",
    cursorModeId: "agent",
    cursorConfigValues: {},
  } satisfies NativeControlState,
  attachments: [],
  contextAttachments: [],
  iosContextItems: [],
  appControlContextItems: [],
  builtInBrowserContextItems: [],
  visualContextPrefix: "",
  visualContextDisplayChips: "",
  isLiteralSlashCommand: false,
} satisfies DraftLaunchSnapshot;
const preparedLaunch = {
  ...launchSnapshot,
  finalText: "fix the flaky test",
  finalDisplayText: "fix the flaky test",
  selectedAttachments: [],
  selectedContextAttachments: [],
} satisfies PreparedDraftLaunch;

const launchBinding: OpenProjectBinding = {
  kind: "local",
  key: "local:/tmp/project-under-test",
  rootPath: "/tmp/project-under-test",
  displayName: "project-under-test",
};

function rendererLaunchDeps(
  kind: DraftLaunchKind,
  mode: DraftLaunchMode,
  calls: string[],
  handoffOrigin: ComposerHandoff | null = null,
): RendererOwnedLaunchDeps {
  return {
    kind,
    mode,
    snapshot: launchSnapshot,
    launchBinding,
    requestKey: "request",
    autoCreate: false,
    paneLaneId: "lane-1",
    jobId: "job-1",
    jobTitle: "fix the flaky test",
    latestForegroundJobIdRef: { current: null },
    inFlightKeysRef: { current: new Set(["request"]) },
    paneMountedRef: { current: true },
    captureHandoffOrigin: () => {
      calls.push("capture");
      return handoffOrigin;
    },
    prepare: () => preparedLaunch,
    resolveLane: async () => ({ laneId: "lane-1", laneName: "Lane 1", worktreePath: null, autoCreated: false }),
    startChat: async () => {
      calls.push("start");
      return { sessionId: "session-1", draftKind: "chat" };
    },
    startCli: async () => {
      calls.push("start");
      return { sessionId: "session-1", draftKind: "cli" };
    },
    clearPromptSuggestion: () => {},
    setError: () => {},
    setDraftLaunchJobs: () => {},
    clearDraftLaunchComposer: () => calls.push("clear"),
    patchDraftLaunchJob: () => {},
    draftLaunchJobExists: () => true,
    canRefreshPinnedProject: () => true,
    refreshSessions: async () => {},
    refreshLanes: async () => {},
    openLaunchedDraftSession: vi.fn((launch) => {
      calls.push(launch.firstMessage ? "open-with-first-message" : "open");
    }),
    clearSelectedSession: () => {},
  };
}

describe("composer handoff stash", () => {
  it("falls back to the docked composer when the empty state has no inline composer", () => {
    const shell = document.createElement("div");
    const emptyState = document.createElement("div");
    emptyState.setAttribute("data-chat-empty-state", "");
    const dock = document.createElement("div");
    dock.setAttribute("data-chat-composer-dock", "");
    shell.append(emptyState, dock);

    expect(findDraftComposerHandoffElement(shell)).toBe(dock);
  });

  it("finds both empty-draft layouts and captures the send-time composer origin", () => {
    const surface = document.createElement("div");
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-chat-composer-wrapper", "");
    const dock = document.createElement("div");
    dock.setAttribute("data-chat-composer-dock", "");
    wrapper.appendChild(dock);
    surface.appendChild(wrapper);

    expect(findComposerHandoffElement(surface)).toBe(wrapper);

    surface.replaceChildren(dock);
    expect(findComposerHandoffElement(surface)).toBe(dock);

    const message = firstMessage("session-1");
    stashComposerDockOrigin("session-1", draftComposer(), { firstMessage: message });
    expect(peekComposerHandoffFirstMessage("session-1")).toBe(message);
    expect(hasPendingComposerDock("session-1")).toBe(true);

    const handoff = takeComposerDockOrigin("session-1");
    expect(handoff).toEqual({
      composer: { left: 100, top: 400, width: 600, height: 120 },
      // Content-box origin: the text box's rect plus its padding; and the box.
      text: { left: 126, top: 420, box: { left: 110, top: 410, width: 580, height: 40 } },
      firstMessage: message,
    });
    expect(takeComposerDockOrigin("session-1")).toBeNull();
    expect(peekComposerHandoffFirstMessage("session-1")).toBeNull();
  });
});

type FakeAnimation = EventTarget & { keyframes: Keyframe[]; target: HTMLElement };
let animations: FakeAnimation[];
let reducedMotion: boolean;
let resourceUsage: ReturnType<typeof vi.fn>;
const originalAdeDescriptor = Object.getOwnPropertyDescriptor(window, "ade");

beforeEach(async () => {
  animations = [];
  reducedMotion = false;
  resourceUsage = vi.fn().mockResolvedValue({ cpuPercent: 0 });
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: { app: { getResourceUsage: resourceUsage } },
  });
  await getAppResourceUsageCoalesced();
  HTMLElement.prototype.animate = function animate(this: HTMLElement, keyframes: Keyframe[] | PropertyIndexedKeyframes | null) {
    const animation = Object.assign(new EventTarget(), { keyframes: keyframes as Keyframe[], target: this });
    animations.push(animation);
    return animation as unknown as Animation;
  };
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: reducedMotion })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  document.body.innerHTML = "";
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  if (originalAdeDescriptor) Object.defineProperty(window, "ade", originalAdeDescriptor);
  else delete (window as unknown as { ade?: unknown }).ade;
});

describe("playFirstMessageFlight", () => {
  function chatWithBubble(): { root: HTMLElement; card: HTMLElement } {
    const root = document.createElement("section");
    const appearanceRoot = document.createElement("div");
    appearanceRoot.setAttribute("data-chat-appearance-root", "");
    appearanceRoot.style.setProperty("--chat-font-size", "14px");
    const row = document.createElement("div");
    const card = withRect(document.createElement("div"), rect(300, 80, 400, 60));
    card.setAttribute("data-chat-user-message-card", "");
    card.style.paddingLeft = "12px";
    card.style.paddingTop = "8px";
    card.textContent = "fix the flaky test";
    row.appendChild(card);
    appearanceRoot.appendChild(row);
    root.appendChild(appearanceRoot);
    document.body.appendChild(root);
    return { root, card };
  }

  const typedPrompt = {
    text: "fix the flaky test",
    width: 548,
    height: 22,
    font: "400 13px Inter",
    lineHeight: "20.8px",
    letterSpacing: "normal",
    color: "rgb(230, 230, 230)",
  };
  const promptBox = { left: 110, top: 410, width: 580, height: 40 };

  it("parks on the prompt, then morphs the prompt's text box into the bubble", async () => {
    const { root, card } = chatWithBubble();

    playFirstMessageFlight(root, { left: 126, top: 420, box: promptBox, typed: typedPrompt });

    const overlay = document.querySelector<HTMLElement>("[data-chat-first-message-flight]")!;
    expect(overlay.style.position).toBe("fixed");
    expect(overlay.inert).toBe(true);
    expect(overlay.style.getPropertyValue("--chat-font-size")).toBe("14px");
    expect(overlay.querySelector("[data-chat-user-message-card]")).toBeNull();
    const [chrome, bubbleText, typed] = Array.from(overlay.children) as HTMLElement[];
    // Parked: every layer is laid out at the bubble and transformed back onto
    // the prompt. The chrome covers the prompt's whole text box (still
    // invisible), the typed copy sits on the typed text, the bubble text
    // waits unseen.
    expect([chrome!.style.left, chrome!.style.top, chrome!.style.width, chrome!.style.height])
      .toEqual(["300px", "80px", "400px", "60px"]);
    expect(chrome!.style.transform).toBe("translate(-190px, 330px) scale(1.45, 0.6666666666666666)");
    expect(chrome!.style.opacity).toBe("0");
    expect(chrome!.style.willChange).toBe("transform, opacity");
    expect(chrome!.style.backdropFilter).toBe("none");
    expect(typed!.textContent).toBe("fix the flaky test");
    expect([typed!.style.left, typed!.style.top, typed!.style.color]).toEqual(["126px", "420px", "rgb(230, 230, 230)"]);
    expect(bubbleText!.style.opacity).toBe("0");
    expect(bubbleText!.style.background).toContain("transparent");
    expect(card.style.visibility).toBe("hidden");
    expect(animations).toHaveLength(0);

    // The pane's layout moves after mount; the morph aims where the bubble ends up.
    card.getBoundingClientRect = () => rect(500, 80, 400, 60);
    await vi.waitFor(() => expect(animations.length).toBeGreaterThan(0));
    const on = (target: HTMLElement) => animations.filter((animation) => animation.target === target);
    // Only transform and opacity animate (compositor-only), from the prompt's
    // text box to the bubble's settled geometry.
    for (const animation of animations) {
      for (const keyframe of animation.keyframes) {
        expect(Object.keys(keyframe).filter((key) => key !== "offset").every((key) => key === "transform" || key === "opacity")).toBe(true);
      }
    }
    expect([chrome!.style.left, chrome!.style.top]).toEqual(["500px", "80px"]);
    expect(on(chrome!)[0]!.keyframes[0]).toEqual({ transform: "translate(-390px, 330px) scale(1.45, 0.6666666666666666)", opacity: 0 });
    expect(on(chrome!)[0]!.keyframes.at(-1)).toEqual({ transform: "translate(0px, 0px) scale(1, 1)", opacity: 1 });
    // The typed text only rises; it never crosses the screen.
    expect(on(typed!)[0]!.keyframes).toEqual([{ transform: "translate(0px, 0px)" }, { transform: "translate(0px, -332px)" }]);
    expect(on(typed!)[1]!.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(on(bubbleText!)[0]!.keyframes).toEqual([{ transform: "translate(-386px, 332px)" }, { transform: "translate(0px, 0px)" }]);

    on(chrome!)[0]!.dispatchEvent(new Event("finish"));
    expect(document.querySelector("[data-chat-first-message-flight]")).toBeNull();
    expect(card.style.visibility).toBe("");
  });

  it("uses bubble text without a typed copy and waits for a late-mounted bubble", async () => {
    const root = document.createElement("section");
    document.body.appendChild(root);

    playFirstMessageFlight(root, { left: 126, top: 420 });
    expect(document.querySelector("[data-chat-first-message-flight]")).toBeNull();

    const card = withRect(document.createElement("div"), rect(300, 80, 400, 60));
    card.setAttribute("data-chat-user-message-card", "");
    root.appendChild(card);

    await vi.waitFor(() => {
      expect(document.querySelector("[data-chat-first-message-flight]")).not.toBeNull();
    });
    const overlay = document.querySelector<HTMLElement>("[data-chat-first-message-flight]")!;
    const [chrome, bubbleText] = Array.from(overlay.children) as HTMLElement[];
    expect(overlay.children).toHaveLength(2);
    expect(bubbleText!.style.opacity).toBe("");
    expect(card.style.visibility).toBe("hidden");
    await vi.waitFor(() => expect(animations.length).toBeGreaterThan(0));
    // With no measured text box the chrome and bubble text start bubble-sized
    // on the prompt after the late-mounted target settles.
    expect(animations.find((animation) => animation.target === chrome)!.keyframes[0])
      .toEqual({ transform: "translate(-174px, 340px) scale(1, 1)", opacity: 0 });
    expect(animations.find((animation) => animation.target === bubbleText)!.keyframes[0])
      .toEqual({ transform: "translate(-174px, 340px)" });
  });

  it("shows the real bubble if frames never come and skips under safety gates", async () => {
    vi.useFakeTimers();
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    try {
      const { root, card } = chatWithBubble();
      playFirstMessageFlight(root, { left: 126, top: 420 });
      expect(document.querySelector("[data-chat-first-message-flight]")).not.toBeNull();

      vi.advanceTimersByTime(1_500);

      expect(document.querySelector("[data-chat-first-message-flight]")).toBeNull();
      expect(card.style.visibility).toBe("");
      expect(animations).toHaveLength(0);

      reducedMotion = true;
      document.body.innerHTML = "";
      animations = [];
      const { root: reducedRoot, card: reducedCard } = chatWithBubble();
      playFirstMessageFlight(reducedRoot, { left: 126, top: 420 });
      expect(document.querySelector("[data-chat-first-message-flight]")).toBeNull();
      expect(reducedCard.style.visibility).toBe("");
      expect(animations).toHaveLength(0);

      reducedMotion = false;
      resourceUsage.mockResolvedValueOnce({ cpuPercent: 70 });
      await getAppResourceUsageCoalesced();
      expect(latestAppResourcePressureLevel()).toBe(3);
      document.body.innerHTML = "";
      animations = [];
      const { root: pressuredRoot, card: pressuredCard } = chatWithBubble();
      playFirstMessageFlight(pressuredRoot, { left: 126, top: 420 });
      expect(document.querySelector("[data-chat-first-message-flight]")).toBeNull();
      expect(pressuredCard.style.visibility).toBe("");
      expect(animations).toHaveLength(0);
    } finally {
      raf.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("playComposerDock", () => {
  it("pins the docked composer at the draft position until the pane settles, then glides it down", async () => {
    const composer = withRect(document.createElement("div"), rect(100, 700, 600, 80));
    const surface = document.createElement("div");
    const text = document.createElement("div");
    text.setAttribute("data-chat-composer-text", "");
    surface.appendChild(text);
    composer.appendChild(surface);
    document.body.appendChild(composer);

    playComposerDock(composer, { left: 100, top: 400, width: 600, height: 120 });

    // Bottom edges aligned: 400+120 vs 700+80.
    expect(composer.style.transform).toBe("translate(0px, -260px)");
    expect(surface.style.opacity).toBe("0");
    expect(animations).toHaveLength(0);

    await vi.waitFor(() => expect(animations).toHaveLength(2));
    expect(composer.style.transform).toBe("");
    expect(animations[0]!.keyframes).toEqual([
      { transform: "translate(0px, -260px)" },
      { transform: "translate(0px, 0px)" },
    ]);
    expect(animations[1]!.target).toBe(surface);
    animations[0]!.dispatchEvent(new Event("finish"));
    expect(surface.style.opacity).toBe("");
  });

  it("opens the clipping footer for the glide and restores it afterwards", async () => {
    const surface = withRect(document.createElement("section"), rect(0, 0, 800, 800));
    const footer = withRect(document.createElement("div"), rect(100, 700, 600, 80));
    footer.style.overflow = "hidden";
    const composer = withRect(document.createElement("div"), rect(100, 700, 600, 80));
    footer.appendChild(composer);
    surface.appendChild(footer);
    document.body.appendChild(surface);

    playComposerDock(composer, { left: 100, top: 400, width: 600, height: 120 });

    // The footer does not contain the start rect, so it stops clipping; the
    // surface does, so the walk stops there.
    expect(footer.style.overflow).toBe("visible");
    expect(surface.style.overflow).toBe("");
    await vi.waitFor(() => expect(animations).toHaveLength(1));
    expect(footer.style.overflow).toBe("visible");

    animations[0]!.dispatchEvent(new Event("finish"));
    expect(footer.style.overflow).toBe("hidden");
  });
});

describe("departing draft chrome", () => {
  function draftSurface(): HTMLElement {
    const surface = document.createElement("div");
    const switcher = withRect(document.createElement("div"), rect(560, 20, 200, 40));
    switcher.dataset.draftDepart = "rise";
    switcher.textContent = "Chat CLI";
    const usage = withRect(document.createElement("div"), rect(400, 520, 520, 200));
    usage.dataset.draftDepart = "fade";
    usage.textContent = "Activity";
    const hidden = withRect(document.createElement("div"), rect(0, 0, 0, 0));
    hidden.dataset.draftDepart = "fade";
    surface.append(switcher, usage, hidden, draftComposer());
    document.body.appendChild(surface);
    return surface;
  }

  it("parks copies over the originals at send, then flies the switcher off the top and fades the rest", async () => {
    const surface = draftSurface();
    stashComposerDockOrigin("session-2", surface.querySelector("div:last-child"), { departingScope: surface });

    // The chat covers the draft surface; the copies stand in for it.
    surface.remove();
    const overlay = document.querySelector<HTMLElement>("[data-chat-draft-departing]")!;
    expect(overlay).not.toBeNull();
    const [switcherCopy, usageCopy] = Array.from(overlay.children) as HTMLElement[];
    expect(overlay.children).toHaveLength(2);
    expect([switcherCopy!.style.left, switcherCopy!.style.top, switcherCopy!.textContent]).toEqual(["560px", "20px", "Chat CLI"]);
    expect(usageCopy!.querySelector("[data-draft-depart]")).toBeNull();

    const handoff = takeComposerDockOrigin("session-2");
    playDepartingDraftChrome(handoff?.departing);
    await vi.waitFor(() => expect(animations).toHaveLength(2));
    const [rise, fade] = animations;
    expect(rise!.target).toBe(switcherCopy);
    // No header to land in: off the top, past its own bottom edge (60) plus a margin.
    expect(rise!.keyframes.at(-1)).toEqual({ transform: "translate(0px, -84px)", opacity: 0 });
    expect(fade!.keyframes).toEqual([
      { transform: "translate(0px, 0px)", opacity: 1 },
      { transform: "translate(0px, 10px)", opacity: 0 },
    ]);
    await vi.waitFor(() => expect(document.querySelector("[data-chat-draft-departing]")).toBeNull());
  });

  it("morphs the switcher into the chat header, keeping the real header hidden until it lands", async () => {
    const surface = draftSurface();
    stashComposerDockOrigin("session-5", surface.querySelector("div:last-child"), { departingScope: surface });
    surface.remove();
    const header = withRect(document.createElement("div"), rect(400, 32, 900, 36));
    header.setAttribute("data-chat-shell-header", "");
    header.textContent = "New chat";
    document.body.appendChild(header);

    playDepartingDraftChrome(takeComposerDockOrigin("session-5")?.departing, header);

    // Hidden before the chat's first paint: never header and switcher at once.
    expect(header.style.visibility).toBe("hidden");
    await vi.waitFor(() => expect(animations.length).toBeGreaterThanOrEqual(4));
    const overlay = document.querySelector<HTMLElement>("[data-chat-draft-departing]")!;
    const bar = overlay.querySelector<HTMLElement>("[data-chat-header-morph-bar]")!;
    const barMorph = animations.find((animation) => animation.target === bar)!;
    // The bar grows out of the switcher pill (560,20 200x40) into the header.
    expect(barMorph.keyframes[0]).toEqual({ transform: "translate(160px, -12px) scale(0.2222222222222222, 1.1111111111111112)", opacity: 0 });
    expect(barMorph.keyframes.at(-1)).toEqual({ transform: "translate(0px, 0px) scale(1, 1)", opacity: 1 });
    expect(bar.querySelector("[data-chat-shell-header]")).toBeNull();
    for (const animation of animations) {
      for (const keyframe of animation.keyframes) {
        expect(Object.keys(keyframe).filter((key) => key !== "offset").every((key) => key === "transform" || key === "opacity")).toBe(true);
      }
    }

    await vi.waitFor(() => expect(document.querySelector("[data-chat-draft-departing]")).toBeNull(), { timeout: 2_000 });
    expect(header.style.visibility).toBe("");
  });

  it("removes unplayed copies and skips parking under heavy resource pressure", async () => {
    vi.useFakeTimers();
    try {
      const surface = draftSurface();
      stashComposerDockOrigin("session-3", surface.querySelector("div:last-child"), { departingScope: surface });
      expect(document.querySelector("[data-chat-draft-departing]")).not.toBeNull();

      vi.advanceTimersByTime(2_000);

      expect(document.querySelector("[data-chat-draft-departing]")).toBeNull();
      resourceUsage.mockResolvedValueOnce({ cpuPercent: 70 });
      await getAppResourceUsageCoalesced();
      expect(latestAppResourcePressureLevel()).toBe(3);
      document.body.innerHTML = "";
      const pressuredSurface = draftSurface();
      stashComposerDockOrigin("session-4", pressuredSurface.querySelector("div:last-child"), { departingScope: pressuredSurface });
      expect(document.querySelector("[data-chat-draft-departing]")).toBeNull();
      expect(takeComposerDockOrigin("session-4")?.departing).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hide the real header for stale clones and refreshes the departure source", () => {
    const surface = draftSurface();
    stashComposerDockOrigin("session-6", surface.querySelector("div:last-child"), { departingScope: surface });
    const captured = takeComposerDockOrigin("session-6")!;
    const expired = captured.departing!;
    expired.host.remove();

    const header = document.createElement("div");
    header.setAttribute("data-chat-shell-header", "");
    document.body.appendChild(header);
    playDepartingDraftChrome(expired, header);
    expect(header.style.visibility).toBe("");
    expect(document.querySelector("[data-chat-draft-departing]")).toBeNull();

    const refreshed = refreshComposerHandoffDeparture(captured, surface);

    expect(refreshed).not.toBe(captured);
    expect(refreshed.composer).toEqual(captured.composer);
    expect(refreshed.text).toEqual(captured.text);
    expect(refreshed.departing).not.toBe(expired);
    expect(refreshed.departing?.host.isConnected).toBe(true);
    expect(document.querySelectorAll("[data-chat-draft-departing]")).toHaveLength(1);
  });

});

describe("renderer-owned launch handoff", () => {
  it("holds a foreground prompt until open and clears only its captured content", async () => {
    const calls: string[] = [];
    const handoffOrigin: ComposerHandoff = {
      composer: { left: 12, top: 34, width: 500, height: 100 },
      text: { left: 24, top: 48 },
      firstMessage: null,
    };
    const launchDeps = rendererLaunchDeps("chat", "foreground", calls, handoffOrigin);

    await runRendererOwnedLaunch(launchDeps);

    const capturedAttachment = { id: "sent-attachment", screenshotDataUrl: "not-persisted" };
    const currentAttachments = [{ id: "sent-attachment" }, { id: "added-while-waiting" }];
    expect(calls).toEqual(["capture", "start", "open-with-first-message", "clear"]);
    expect(launchDeps.openLaunchedDraftSession).toHaveBeenCalledWith(
      expect.objectContaining({ composerHandoff: handoffOrigin, firstMessage: preparedLaunch }),
    );
    expect(removeSubmittedDraftItems(currentAttachments, [capturedAttachment], sameStoredDraftItem))
      .toEqual([{ id: "added-while-waiting" }]);
    expect(clearSubmittedDraftText("submitted prompt", "submitted prompt")).toBe("");
    expect(clearSubmittedDraftText(
      "submitted prompt plus a later thought",
      "submitted prompt",
      { submittedText: "submitted prompt", kind: "append" },
    ))
      .toBe(" plus a later thought");
    expect(clearSubmittedDraftText("new prompt typed while waiting", "submitted prompt"))
      .toBe("new prompt typed while waiting");
    expect(clearSubmittedDraftText(
      "Fix bug in tests",
      "Fix bug",
      { submittedText: "Fix bug", kind: "replacement" },
    )).toBe("Fix bug in tests");
    expect(clearSubmittedDraftText(
      "Fix bug",
      "Fix bug",
      { submittedText: "Fix bug", kind: "replacement" },
    )).toBe("Fix bug");
    expect(removeSubmittedDraftItemsById(
      [{ path: "/tmp/same.txt" }],
      ["reattached-id"],
      [{ path: "/tmp/same.txt" }],
      ["submitted-id"],
      sameStoredDraftItem,
    )).toEqual({ items: [{ path: "/tmp/same.txt" }], ids: ["reattached-id"] });
  });

  it("keeps the visual origin through remount and expires unused recovery state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const calls: string[] = [];
      const handoffOrigin: ComposerHandoff = {
        composer: { left: 12, top: 34, width: 500, height: 100 },
        text: { left: 24, top: 48 },
        firstMessage: null,
      };
      const launchDeps = {
        ...rendererLaunchDeps("chat", "foreground", calls, handoffOrigin),
        paneMountedRef: { current: false },
      };
      await runRendererOwnedLaunch(launchDeps);

      expect(calls).toEqual(["capture", "start", "clear"]);
      expect(launchDeps.openLaunchedDraftSession).not.toHaveBeenCalled();
      expect(takeRendererLaunchHandoff("job-1")).toBe(handoffOrigin);
      expect(takeRendererLaunchHandoff("job-1")).toBeNull();

      stashRendererLaunchHandoff("job-expiry", handoffOrigin);
      vi.advanceTimersByTime(DRAFT_LAUNCH_JOB_STALE_AFTER_MS + 1);
      // If only the lazy sweep existed, the reset clock would still find it.
      vi.setSystemTime(1_000);
      expect(takeRendererLaunchHandoff("job-expiry")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves failed prompts intact and clears dismissed, background, and CLI launches", async () => {
    const failedCalls: string[] = [];
    const failed = rendererLaunchDeps("chat", "foreground", failedCalls, {
      composer: { left: 12, top: 34, width: 500, height: 100 },
      text: { left: 24, top: 48 },
      firstMessage: null,
    });
    await runRendererOwnedLaunch({
      ...failed,
      startChat: async () => { throw new Error("create failed"); },
    });
    expect(failedCalls).toEqual(["capture"]);
    expect(failed.openLaunchedDraftSession).not.toHaveBeenCalled();
    expect(takeRendererLaunchHandoff("job-1")).toBeNull();

    const dismissedCalls: string[] = [];
    await runRendererOwnedLaunch({
      ...rendererLaunchDeps("chat", "foreground", dismissedCalls),
      draftLaunchJobExists: () => false,
    });
    expect(dismissedCalls).toEqual(["capture", "start", "clear"]);

    const backgroundCalls: string[] = [];
    await runRendererOwnedLaunch(rendererLaunchDeps("chat", "background", backgroundCalls));
    const cliCalls: string[] = [];
    await runRendererOwnedLaunch(rendererLaunchDeps("cli", "foreground", cliCalls));
    expect(backgroundCalls).toEqual(["clear", "start"]);
    expect(cliCalls).toEqual(["clear", "start", "open"]);
  });
});
