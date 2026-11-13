/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const { codeToHtml } = vi.hoisted(() => ({ codeToHtml: vi.fn() }));

// The real highlighter, with its whole-block render counted.
vi.mock("shiki", async (importOriginal) => {
  const shiki = await importOriginal<typeof import("shiki")>();
  return {
    ...shiki,
    createHighlighter: async (options: Parameters<typeof shiki.createHighlighter>[0]) => {
      const highlighter = await shiki.createHighlighter(options);
      const render = highlighter.codeToHtml.bind(highlighter);
      codeToHtml.mockImplementation(render);
      highlighter.codeToHtml = codeToHtml as unknown as typeof highlighter.codeToHtml;
      return highlighter;
    },
  };
});

import { createHighlighter, createJavaScriptRegexEngine } from "shiki";
import { HighlightedCode } from "./CodeHighlighter";

describe("HighlightedCode", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a cached block highlighted on the first frame, with no plain-text pass", async () => {
    const first = render(<HighlightedCode code="const cached = 1;" language="typescript" />);
    // Uncached: plain first, then the highlight lands.
    expect(first.container.querySelector(".shiki-highlighted")).toBeNull();
    await waitFor(() => expect(first.container.querySelector(".shiki-highlighted pre.shiki")).not.toBeNull());
    first.unmount();
    const calls = codeToHtml.mock.calls.length;

    // A remount (a virtualized row scrolling back in, a reopened chat): the
    // very first render is already highlighted, synchronously.
    const second = render(<HighlightedCode code="const cached = 1;" language="typescript" />);
    expect(second.container.querySelector(".shiki-highlighted pre.shiki")?.textContent).toBe("const cached = 1;");
    expect(second.container.querySelector("pre:not(.shiki)")).toBeNull();
    expect(codeToHtml.mock.calls.length).toBe(calls);
  });

  it("shows new text plain until it highlights, never the previous block's highlight", async () => {
    const view = render(<HighlightedCode code="let a = 1;" language="typescript" />);
    await waitFor(() => expect(view.container.querySelector(".shiki-highlighted")).not.toBeNull());
    view.rerender(<HighlightedCode code={"let a = 1;\nlet b = 2;"} language="typescript" />);
    expect(view.container.querySelector("pre")?.textContent).toBe("let a = 1;\nlet b = 2;");
    await waitFor(() => expect(view.container.querySelector(".shiki-highlighted pre.shiki")?.textContent)
      .toBe("let a = 1;\nlet b = 2;"));
  });

  it("highlights a streaming block the same as a whole-block render at every frame", async () => {
    const reference = await createHighlighter({
      themes: ["github-dark-dimmed"],
      langs: ["typescript"],
      engine: createJavaScriptRegexEngine(),
    });
    // A template literal and a block comment span lines, so a frame is only
    // right when the grammar state carries across the lines already rendered.
    const lines = [
      "const greeting = `hello",
      "  ${name} and",
      "  more`;",
      "/* opens a comment",
      "   still a comment */",
      "function add(a: number, b: number) {",
      "  return a + b;",
      "}",
    ];
    const frames: string[] = [];
    for (let i = 1; i <= lines.length; i++) {
      const text = lines.slice(0, i).join("\n");
      frames.push(text.slice(0, -3), text, `${text}\n\n`);
    }

    const view = render(<HighlightedCode code={frames[0]!} language="typescript" />);
    const expected = document.createElement("div");
    for (const frame of frames) {
      view.rerender(<HighlightedCode code={frame} language="typescript" />);
      // The block drops one trailing newline before it highlights.
      const shown = frame.replace(/\n$/, "");
      expected.innerHTML = reference.codeToHtml(shown, { lang: "typescript", theme: "github-dark-dimmed" });
      await waitFor(() => expect(view.container.querySelector(".shiki-highlighted pre.shiki")?.textContent).toBe(shown));
      expect(view.container.querySelector(".shiki-highlighted")?.innerHTML, `frame ${JSON.stringify(frame)}`)
        .toBe(expected.innerHTML);
    }
    expect(view.container.querySelectorAll(".shiki-highlighted .line").length).toBe(lines.length + 1);
  });
});

describe("running a shell code block", () => {
  const decodePowerShell = (encoded: string) => Buffer.from(encoded, "base64").toString("utf16le");
  const heredoc = "cat <<'EOF'\nkeep $HOME literal\nEOF\nexit 3";

  it.each([
    // What runs is the block itself, as one argument to its interpreter.
    { language: "bash", code: `${heredoc}\n`, windows: false, command: "bash", script: heredoc },
    { language: "zsh", code: "print -r -- hi", windows: false, command: "zsh", script: "print -r -- hi" },
    // A console block runs its prompt lines only, joining a `\` continuation.
    {
      language: "console",
      code: "$ echo one\none\n$ echo two \\\n>   more\ntwo more\n% pwd\n/x",
      windows: false,
      command: "bash",
      script: "echo one\necho two \\\n  more\npwd",
    },
    { language: "powershell", code: "Write-Output 'hi'\r\nexit 2", windows: true, command: "powershell.exe", script: "Write-Output 'hi'\nexit 2" },
    // Refused, with a reason: the other OS's shell, cmd, or text that reads differently from what runs.
    { language: "powershell", code: "Get-Date", windows: false, command: null, script: null },
    { language: "bash", code: "ls", windows: true, command: null, script: null },
    { language: "cmd", code: "dir /b", windows: true, command: null, script: null },
    { language: "sh", code: "echo safe‮; rm -rf ~", windows: false, command: null, script: null },
  ])("$language on windows=$windows runs $command", async ({ language, code, windows, command, script }) => {
    const { planShellBlockRun } = await import("./shellCodeBlockRun");
    const plan = planShellBlockRun({ code, language, machineIsWindows: windows });
    expect(plan).not.toBeNull();
    if (command === null) {
      expect(plan?.ok).toBe(false);
      expect(plan && !plan.ok ? plan.reason.length : 0).toBeGreaterThan(0);
      return;
    }
    expect(plan?.ok).toBe(true);
    if (!plan?.ok) throw new Error("the plan was refused");
    expect(plan.command).toBe(command);
    const ran = plan.command === "powershell.exe" ? decodePowerShell(plan.args.at(-1) ?? "") : plan.args.at(-1);
    expect(ran).toBe(script);
  });

  it.each(["text", "typescript"])("offers no run for a %s block", async (language) => {
    const { planShellBlockRun } = await import("./shellCodeBlockRun");
    expect(planShellBlockRun({ code: "echo hi", language, machineIsWindows: false })).toBeNull();
    // A console block with no prompt lines has nothing to run either.
    expect(planShellBlockRun({ code: "just output", language: "console", machineIsWindows: false })).toBeNull();
    expect(planShellBlockRun({ code: "   \n", language: "bash", machineIsWindows: false })).toBeNull();
  });

  it("sends the agent the output as a person read it, in fences the output cannot close", async () => {
    const { shellRunResultMessage } = await import("./shellCodeBlockRun");
    const message = shellRunResultMessage({
      script: "printf '```'",
      language: "console",
      machineName: "MacBook Pro",
      folder: "/repo/lane",
      exitCode: 1,
      output: "\u001b[32mgreen\u001b[0m\r\nprogress 10%\rprogress 100%\r\n````\r\n",
    });
    expect(message).toContain("Exit code: 1");
    expect(message).toContain("green\nprogress 100%\n````");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("progress 10%");
    // The output holds a four-backtick run, so its fence is five; the script's fence is four.
    expect(message).toContain("`````text\n");
    expect(message).toContain("````bash\nprintf '```'\n````");

    const long = shellRunResultMessage({
      script: "yes", language: "bash", machineName: "m", folder: "/f", exitCode: null, output: `${"x".repeat(30_000)}END`,
    });
    expect(long).toContain("It ended without an exit code.");
    expect(long).toContain("the last 20,000 characters");
    expect(long).toContain("END");
  });
});
