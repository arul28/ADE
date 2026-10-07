import { describe, expect, it } from "vitest";

import { computerUseActionText } from "./computerUseActionPresentation";
import { summarizeComputerUseCommand, type ComputerUseCommandInput } from "./computerUseActionSummary";

type Expected = {
  text: string;
  surface: string;
  outcome: string;
  reason?: string | null;
} | null;

const ok = (command: string, output = ""): ComputerUseCommandInput => ({ command, output, status: "completed", exitCode: 0 });

describe("computer-use command summary", () => {
  // The sentence is the contract: it is what the transcript row says the agent did.
  it.each<[string, ComputerUseCommandInput, Expected]>([
    ["a non-ADE shell command keeps its shell row", ok("ls -la"), null],
    ["two acting commands in one call are not guessed at", ok("ade screen click --label Save && ade screen type hello"), null],
    // Beside `||` the action may never have run, or the exit code is someone else's.
    ["an action after `||` may never have run", ok("true || ade screen click --label Save"), null],
    ["an action before `||` has its failure masked", ok("ade screen click --label Save 2>&1 || true"), null],
    ["an action after `&&` in a failed call may never have run", { command: "cd app && ade screen click --label Save", output: "", status: "failed", exitCode: 1 }, null],
    [
      "an action after `&&` in a successful call ran",
      ok('cd app && A="$ADE_CLI_PATH"; $A screen click --label Save', 'hit: AXButton "Save" (e1)\neffect: observed'),
      { text: "Clicked “Save” using the lane screen", surface: "lane_screen", outcome: "observed" },
    ],
    [
      "the element actually hit wins over the label asked for",
      ok("ade screen click --label Save", 'hit: AXButton "Save As…" (e12)\neffect: observed — the window changed'),
      { text: "Clicked “Save As…” using the lane screen", surface: "lane_screen", outcome: "observed" },
    ],
    [
      "an unconfirmed effect is its own outcome, with the CLI's reason",
      ok("ade browser click --label Buy --text", 'hit: button "Buy now" (b3)\neffect: unconfirmed — no change seen yet'),
      { text: "Clicked “Buy now” using ADE browser", surface: "ade_browser", outcome: "unconfirmed", reason: "no change seen yet" },
    ],
    [
      "an `ade:` error with a failing exit reads as a failure with its reason",
      { command: "ade app-control click --label Go", output: "ade: No app is running in this lane.", status: "failed", exitCode: 1 },
      { text: "Couldn't click “Go” using App Control", surface: "app_control", outcome: "failed", reason: "No app is running in this lane." },
    ],
    [
      "JSON naming the user's browser target is the user's browser",
      ok(
        "ade browser click --label Send",
        '{"ok":true,"userBrowserTarget":"your Google Chrome on studio-mac","resolved":{"role":"button","name":"Send"},"effect":{"status":"observed"}}',
      ),
      { text: "Clicked “Send” using your Chrome on studio-mac", surface: "user_browser", outcome: "observed" },
    ],
    [
      "page text saying \"Update your browser\" is not the user's browser",
      ok("ade browser observe --text", "title  Update your browser\nurl  https://example.test/\nYour browser is out of date."),
      { text: "Read “Update your browser” on example.test using ADE browser", surface: "ade_browser", outcome: "not_checked" },
    ],
    [
      "`ade mac-desktop` names Mac Desktop",
      ok("ade mac-desktop click --label OK", 'hit: AXButton "OK" (e1)\neffect: observed'),
      { text: "Clicked “OK” using Mac Desktop", surface: "lane_screen", outcome: "observed" },
    ],
    [
      "`ade windows-desktop` names Windows Desktop",
      ok("ade windows-desktop click --label OK", 'hit: Button "OK" (e1)\neffect: observed'),
      { text: "Clicked “OK” using Windows Desktop", surface: "lane_screen", outcome: "observed" },
    ],
    [
      "an Apple device is named from its simulator type id",
      ok("ade apple tap --label Login --device-type com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"),
      { text: "Tapped “Login” using iPhone 16 Pro", surface: "apple_device", outcome: "not_checked" },
    ],
    [
      "proof filed for a PR says which PR",
      ok('ade proof capture --caption "Checkout works" --pr 42'),
      { text: "Filed proof “Checkout works” using ADE proof · on PR #42", surface: "proof", outcome: "not_checked" },
    ],
    [
      "an observe with no target reads as looking at the screen",
      ok("ade screen observe"),
      { text: "Looked at the screen using the lane screen", surface: "lane_screen", outcome: "not_checked" },
    ],
  ])("%s", (_name, input, expected) => {
    const summary = summarizeComputerUseCommand(input);
    if (expected === null) {
      expect(summary).toBeNull();
      return;
    }
    expect(summary, "a computer-use summary").not.toBeNull();
    expect(computerUseActionText(summary!)).toBe(expected.text);
    expect(summary!.surface).toBe(expected.surface);
    expect(summary!.outcome).toBe(expected.outcome);
    expect(summary!.reason).toBe(expected.reason ?? null);
  });
});
