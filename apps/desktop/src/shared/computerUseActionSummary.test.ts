import { describe, expect, it } from "vitest";

import { computerUseActionText, layoutComputerUseRun } from "./computerUseActionPresentation";
import { summarizeComputerUseCommand, type ComputerUseCommandInput } from "./computerUseActionSummary";

type Expected = {
  text: string;
  surface: string;
  outcome: string;
  reason?: string | null;
} | null;

const PROOF_A = "11111111-1111-4111-8111-111111111111";
const PROOF_B = "22222222-2222-4222-8222-222222222222";

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
      { text: "Clicked “Save” on the lane screen", surface: "lane_screen", outcome: "observed" },
    ],
    [
      "the element actually hit wins over the label asked for",
      ok("ade screen click --label Save", 'hit: AXButton "Save As…" (e12)\neffect: observed — the window changed'),
      { text: "Clicked “Save As…” on the lane screen", surface: "lane_screen", outcome: "observed" },
    ],
    [
      "an unconfirmed effect is its own outcome, with the CLI's reason",
      ok("ade browser click --label Buy --text", 'hit: button "Buy now" (b3)\neffect: unconfirmed — no change seen yet'),
      { text: "Clicked “Buy now” using ADE browser", surface: "ade_browser", outcome: "unconfirmed", reason: "no change seen yet" },
    ],
    [
      "an `ade:` error with a failing exit reads as a failure with its reason",
      { command: "ade app-control click --label Go", output: "ade: No app is running in this lane.", status: "failed", exitCode: 1 },
      { text: "Couldn't click “Go”", surface: "app_control", outcome: "failed", reason: "No app is running in this lane." },
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
      { text: "Read “Update your browser” on example.test", surface: "ade_browser", outcome: "not_checked" },
    ],
    [
      "`ade mac-desktop` names Mac Desktop",
      ok("ade mac-desktop click --label OK", 'hit: AXButton "OK" (e1)\neffect: observed'),
      { text: "Clicked “OK” on Mac Desktop", surface: "lane_screen", outcome: "observed" },
    ],
    [
      "`ade windows-desktop` names Windows Desktop",
      ok("ade windows-desktop click --label OK", 'hit: Button "OK" (e1)\neffect: observed'),
      { text: "Clicked “OK” on Windows Desktop", surface: "lane_screen", outcome: "observed" },
    ],
    [
      "an Apple device is named from its simulator type id",
      ok("ade apple tap --label Login --device-type com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"),
      { text: "Tapped “Login” on iPhone 16 Pro", surface: "apple_device", outcome: "not_checked" },
    ],
    [
      "proof filed for a PR says which PR",
      ok('ade proof capture --caption "Checkout works" --pr 42', `cite: ![Checkout works](ade-proof://${PROOF_A})`),
      { text: "Filed proof “Checkout works” · on PR #42", surface: "proof", outcome: "not_checked" },
    ],
    [
      "a look at a whole screen names the screen",
      ok("ade screen observe"),
      { text: "Looked at the lane screen", surface: "lane_screen", outcome: "not_checked" },
    ],
    // An app the action touched names the place; App Control never names itself.
    [
      "an App Control action names the app it drove",
      ok("ade app-control click --label Save", 'title  ADE\nhit: button "Save" (e1)\neffect: observed'),
      { text: "Clicked “Save” in ADE", surface: "app_control", outcome: "observed" },
    ],
    [
      "launching from a shell command names the app, never the command",
      ok('ade app-control launch --command "env PATH=/x npm run dev"', "session  s1\nstatus  running"),
      { text: "Launched the app", surface: "app_control", outcome: "not_checked" },
    ],
    // A filed proof prints its id; the exit code can belong to a later command.
    [
      "a proof call whose output names no proof did not file one",
      ok('ade app-control proof --caption "Empty state"; git commit -m x', "[main 1a2b3c] x"),
      { text: "Couldn't file proof “Empty state”", surface: "app_control", outcome: "failed", reason: "No proof was filed." },
    ],
    [
      "grepping for the cite line and finding none is a failure",
      ok('ade proof capture --caption "Empty state" --text | grep cite:'),
      { text: "Couldn't file proof “Empty state”", surface: "proof", outcome: "failed", reason: "No proof was filed." },
    ],
    [
      "output cut off by another filter cannot confirm the proof",
      ok('ade proof capture --caption "Empty state" --text | tail -1', "Attached"),
      {
        text: "Filed proof “Empty state”",
        surface: "proof",
        outcome: "unconfirmed",
        reason: "Its output was cut off, so ADE could not see the proof filed.",
      },
    ],
    [
      "a filed trace has no cite line but its table and confirmation say it filed",
      ok(
        "ade proof attach ./server.log --caption 'Server log' --text",
        `artifact  kind  title  path\n${PROOF_A}  browser_verification  Server log  .ade/artifacts/x.log\n\nAttached 1 artifact to lane l1 / chat c1 (Server log)`,
      ),
      { text: "Filed proof “Server log”", surface: "proof", outcome: "not_checked" },
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

describe("computer-use run layout", () => {
  // What a run of actions draws: one line per distinct action, "×N" for repeats.
  const drawn = (calls: ComputerUseCommandInput[]) => {
    const { earlier, latest } = layoutComputerUseRun(calls.map((input, index) => ({
      action: index,
      summary: summarizeComputerUseCommand(input)!,
    })));
    return [...earlier, ...(latest ? [latest] : [])]
      .map((line) => `${computerUseActionText(line.summary)}${line.count > 1 ? ` ×${line.count}` : ""}`);
  };
  const capture = (id: string) => ok("ade app-control proof --caption Login --text", `title  ADE\ncite: ![Login](ade-proof://${id})`);

  it.each<[string, ComputerUseCommandInput[], string[]]>([
    [
      "App Control carries its app forward and repeats merge",
      [
        ok("ade app-control observe --text", "title  ADE"),
        ok("ade app-control observe --text"),
        ok("ade app-control press --key Escape --text", "effect: not checked"),
        ok("ade app-control observe --text"),
        ok("ade app-control observe --text"),
      ],
      ["Looked at ADE ×2", "Pressed “Escape” in ADE", "Looked at ADE ×2"],
    ],
    [
      "two captures with one caption are two pictures; a publish marks only what it posted",
      [
        capture(PROOF_A),
        capture(PROOF_B),
        ok(
          `ade proof publish --pr 12 ${PROOF_A} ${PROOF_B} --text`,
          `Posted 1 proof item to https://github.com/o/r/pull/12\n  posted  ${PROOF_A}  Login\n  skipped ${PROOF_B}  not found`,
        ),
      ],
      ["Filed proof “Login” in ADE · posted to PR #12", "Filed proof “Login” in ADE"],
    ],
  ])("%s", (_name, calls, expected) => {
    expect(calls.every((input) => summarizeComputerUseCommand(input) !== null), "every call is a computer-use action").toBe(true);
    expect(drawn(calls)).toEqual(expected);
  });
});
