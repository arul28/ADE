import { describe, expect, it, vi } from "vitest";
import { TERMINAL_BRACKETED_PASTE_END, TERMINAL_BRACKETED_PASTE_START } from "./terminalBracketedPaste";
import { createTerminalLocalLine, localLineAsKeys } from "./terminalLocalLine";

describe("the terminal's local line", () => {
  it.each([
    // Typed text is keys, as it is.
    ["hello", "hello"],
    // A tab pasted into the line is text, not the CLI's completion key, so it
    // goes inside a bracketed paste.
    ["a\tb", `${TERMINAL_BRACKETED_PASTE_START}a\tb${TERMINAL_BRACKETED_PASTE_END}`],
    // A line break must stay one message; a terminal's Enter is a carriage return.
    ["one\ntwo", `${TERMINAL_BRACKETED_PASTE_START}one\rtwo${TERMINAL_BRACKETED_PASTE_END}`],
    ["a\tb\nc", `${TERMINAL_BRACKETED_PASTE_START}a\tb\rc${TERMINAL_BRACKETED_PASTE_END}`],
  ])("hands %j over as the keys that typed it", (text, keys) => {
    expect(localLineAsKeys(text)).toBe(keys);
  });

  it("keeps text until Enter, and never hands over a line whose send is in doubt", () => {
    const onChange = vi.fn();
    const line = createTerminalLocalLine(onChange);

    expect(line.input("h")).toEqual([]);
    expect(line.input("i")).toEqual([]);
    expect(line.text()).toBe("hi");
    expect(onChange).toHaveBeenCalled();

    // Enter on a line submits exactly what was typed.
    expect(line.input("\r")).toEqual([{ kind: "submit", text: "hi" }]);
    expect(line.text()).toBe("");

    // A pasted tab stays in the line, and Enter sends it as one line.
    line.paste("a\tb\nc");
    expect(line.text()).toBe("a\tb\nc");
    // Shift+Enter adds a line; an edit changes only the local text.
    expect(line.newline()).toBe(true);
    expect(line.input("\x7f")).toEqual([]);
    expect(line.text()).toBe("a\tb\nc");
    expect(line.input("\r")).toEqual([{ kind: "submit", text: "a\tb\nc" }]);

    // A line whose send could not be confirmed only submits through Enter:
    // other keys reach the CLI without it, so no path can type it twice.
    line.restore("retry me");
    expect(line.input("\t", { handOver: false })).toEqual([{ kind: "write", data: "\t" }]);
    expect(line.text()).toBe("retry me");
    expect(line.input("\r")).toEqual([{ kind: "submit", text: "retry me" }]);

    // A line typed behind a failed one keeps its place after it.
    line.restore("first");
    line.append("second");
    expect(line.text()).toBe("firstsecond");
  });
});
