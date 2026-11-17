import { describe, expect, it } from "vitest";
import { CLOUD_LAUNCH_MAX_ARGS_BYTES } from "../../../account-directory/src/cloud/contract";
import { cloudLaunchAppArgs } from "./cloudLaneLaunch";
import type { ChatLaunchArgs } from "./types/chatLaunch";

type AppLaunch = Omit<ChatLaunchArgs, "cloud" | "priorStages">;

const LOCAL_FILE = { path: "/Users/me/secret-notes.md", type: "file" as const };
const LINK = { path: "shot.png", type: "image-url" as const, url: "https://example.com/shot.png" };

function chatLaunch(overrides: Partial<AppLaunch> = {}, displayText: string | null = null): AppLaunch {
  return {
    kind: "chat",
    mode: "foreground",
    launchId: "launch-1",
    prompt: "Fix the private bug in billing",
    attachments: [LOCAL_FILE, LINK],
    laneConfig: { mode: "new" },
    chat: {
      create: { provider: "claude", model: "opus" } as NonNullable<AppLaunch["chat"]>["create"],
      message: { text: "Fix the private bug in billing", displayText, attachments: [LOCAL_FILE, LINK] },
    },
    ...overrides,
  };
}

/** The app args the account server keeps for a launch (`CloudServerLaunchRequest.launch`). */
describe("cloudLaunchAppArgs", () => {
  it("keeps the prompt and this computer's files off the server, and fits the server's size cap", () => {
    const args = cloudLaunchAppArgs(chatLaunch());
    expect(args).not.toBeNull();
    const text = JSON.stringify(args);
    // The prompt travels as the launch's message, never in the saved app args.
    expect(text).not.toContain("private bug");
    // A path on this computer means nothing on the cloud computer and stays here; a link goes.
    expect(text).not.toContain(LOCAL_FILE.path);
    expect((args as { attachments: unknown[] }).attachments).toEqual([LINK]);
    expect((args as { chat: { message: { attachments: unknown[] } } }).chat.message.attachments).toEqual([LINK]);
    // A new lane on a cloud computer always starts there.
    expect((args as { laneConfig: { mode: string; start: { on: string } } }).laneConfig).toMatchObject({ mode: "new", start: { on: "remote" } });

    // A display text over the cap is dropped, and the rest still goes.
    const long = "x".repeat(CLOUD_LAUNCH_MAX_ARGS_BYTES);
    const trimmed = cloudLaunchAppArgs(chatLaunch({ displayPrompt: long }, long));
    expect(trimmed).not.toBeNull();
    expect(new TextEncoder().encode(JSON.stringify(trimmed)).length).toBeLessThanOrEqual(CLOUD_LAUNCH_MAX_ARGS_BYTES);
    expect((trimmed as { chat: { message: { displayText: unknown } } }).chat.message.displayText).toBeNull();

    // Still over the cap without it: nothing, so the server never refuses the launch for its size.
    expect(cloudLaunchAppArgs(chatLaunch({ title: long }))).toBeNull();
  });
});
