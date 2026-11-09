import { describe, expect, it } from "vitest";
import { findPrTaskBoxes, togglePrTaskInBody } from "./prTaskList";

describe("togglePrTaskInBody", () => {
  it.each([
    { name: "a fenced look-alike", body: "```md\n- [ ] no\n```\n\n- [ ] yes\n", index: 0, next: true, expected: "```md\n- [ ] no\n```\n\n- [x] yes\n" },
    { name: "an indented code look-alike", body: "    - [ ] no\n\n- [ ] yes\n", index: 0, next: true, expected: "    - [ ] no\n\n- [x] yes\n" },
    { name: "an HTML block look-alike", body: "<details>\n- [ ] no\n</details>\n\n- [ ] yes\n", index: 0, next: true, expected: "<details>\n- [ ] no\n</details>\n\n- [x] yes\n" },
    { name: "CRLF line endings", body: "- [ ] a\r\n- [ ] b\r\n", index: 1, next: true, expected: "- [ ] a\r\n- [x] b\r\n" },
    { name: "an upper-case box", body: "> 1. [X] quoted\n", index: 0, next: false, expected: "> 1. [ ] quoted\n" },
    { name: "a box already in that state", body: "- [x] a\n", index: 0, next: true, expected: null },
    { name: "a box that is not there", body: "- [ ] a\n", index: 3, next: true, expected: null },
  ])("handles $name", ({ body, index, next, expected }) => {
    const before = findPrTaskBoxes(body.replace(/\r\n/g, "\n"));
    const result = togglePrTaskInBody(body, body, index, next);
    expect(result).toBe(expected);
    if (result !== null) {
      // One character changes, and no box is added or lost.
      expect(result.length).toBe(body.length);
      expect(findPrTaskBoxes(result.replace(/\r\n/g, "\n"))).toHaveLength(before.length);
    }
  });

  it("refuses text that appears twice with the box in the same state, and takes the one that differs", () => {
    const part = "- [ ] same";
    expect(togglePrTaskInBody(`## A\n${part}\n\n## B\n${part}\n`, part, 0, true)).toBeNull();
    expect(togglePrTaskInBody(`## A\n- [x] same\n\n## B\n${part}\n`, part, 0, true)).toBe("## A\n- [x] same\n\n## B\n- [x] same\n");
  });
});
