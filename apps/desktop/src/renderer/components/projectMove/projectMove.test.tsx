/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMoveRecord } from "../../../shared/types/projectMove";
import type { OpenProjectBinding } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { getAppBannerEntries, resetAppBannersForTests } from "../ui/notice/appBannerStore";
import { MoveProjectDialog } from "./MoveProjectDialog";
import { ProjectMoveHost } from "./ProjectMoveHost";

const MOVED: ProjectMoveRecord = {
  moveId: "move-1",
  projectName: "fleet",
  sourceRoot: "/Users/me/Projects/fleet",
  destinationRoot: "/Volumes/Dev/Projects/fleet",
  originalParkedAt: "/Users/me/Projects/fleet (moved to Dev)",
  originalBytes: 29_000_000,
  destinationVolumeUuid: "uuid",
  destinationVolumeName: "Dev",
  destinationInternal: false,
  startedAt: 1,
  finishedAt: 2,
  state: "done",
  cleanup: { choice: "pending" },
  followUps: [],
  problems: [],
};

const REMOTE: OpenProjectBinding = { kind: "remote", key: "remote:mac-mini" } as OpenProjectBinding;

const attention = vi.fn(async () => ({ records: [MOVED], nextReminderAt: null }));

beforeEach(() => {
  Object.defineProperty(window.navigator, "platform", { configurable: true, value: "MacIntel" });
  (window as any).ade = { projectMove: { attention } };
});

afterEach(() => {
  cleanup();
  resetAppBannersForTests();
  attention.mockClear();
  delete (window as any).ade;
});

/**
 * The kept old copy belongs to the project that moved: its banner shows in
 * that project's tab only, never over another project the window has open.
 */
describe("ProjectMoveHost old-copy banner", () => {
  it.each([
    { open: "the moved project", rootPath: MOVED.destinationRoot, binding: null, shows: true },
    { open: "another project", rootPath: "/Users/me/Projects/ADE", binding: null, shows: false },
    { open: "the moved path on another machine", rootPath: MOVED.destinationRoot, binding: REMOTE, shows: false },
  ])("with $open open, shows the banner: $shows", async ({ rootPath, binding, shows }) => {
    useAppStore.setState({ project: { rootPath, displayName: "x" } as never, projectBinding: binding });

    render(<ProjectMoveHost />);
    await act(async () => {});

    expect(attention).toHaveBeenCalled();
    const banners = getAppBannerEntries().filter((entry) => entry.model.id.startsWith("project-move-old-copy:"));
    expect(banners.map((entry) => entry.model.id)).toEqual(shows ? [`project-move-old-copy:${MOVED.moveId}`] : []);
    if (shows) expect(banners[0]!.model.title).toContain(MOVED.projectName);
  });
});

/**
 * The check agent after a move is set up in place: nothing starts until the
 * person presses Start agent, it runs with ask-first permissions unless they
 * widen them, and it gets the prompt as they left it.
 */
describe("MoveProjectDialog check agent", () => {
  it("launches only on Start agent, in the main lane, with ask-first permissions and the edited prompt", async () => {
    const launch = vi.fn(async (_args: Record<string, unknown>) => ({ id: "session-1" }));
    const start = vi.fn(async () => ({ ok: true, record: MOVED }));
    const bridge = {
      projectMove: {
        listVolumes: vi.fn(async () => [{ name: "Dev", mountPath: "/Volumes/Dev", internal: false, freeBytes: 10, totalBytes: 20, suggestedFolder: "/Volumes/Dev/Projects" }]),
        preflight: vi.fn(async () => ({ checks: [], notes: [], agentHistory: [], copyBytes: 1, laneCount: 1 })),
        onProgress: () => () => {},
        start,
      },
      lanes: { list: vi.fn(async () => [{ id: "lane-main", laneType: "primary" }]) },
      agentChat: { launch },
    };
    // Every other bridge call the dialog's pickers make answers empty.
    (window as any).ade = new Proxy(bridge, {
      get: (target: Record<string, unknown>, key: string) => target[key] ?? new Proxy({}, { get: () => vi.fn(async () => null) }),
    });

    render(<MoveProjectDialog open onClose={() => {}} projectRoot={MOVED.sourceRoot} projectName={MOVED.projectName} />);
    const move = await screen.findByRole("button", { name: "Move" });
    await waitFor(() => expect((move as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(move);
    fireEvent.click(await screen.findByRole("button", { name: /Set up/ }));

    const prompt = screen.getByRole("textbox", { name: "Prompt for the check agent" }) as HTMLTextAreaElement;
    expect(prompt.value).toContain(MOVED.destinationRoot);
    expect(launch).not.toHaveBeenCalled();
    fireEvent.change(prompt, { target: { value: "Only run git status." } });
    fireEvent.click(screen.getByRole("button", { name: /Start agent/ }));

    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    expect(launch.mock.calls[0]![0]).toMatchObject({
      laneId: "lane-main",
      kickoffText: "Only run git status.",
      permissionMode: "default",
      claudePermissionMode: "default",
    });
  });
});
