/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { readAssistantOutputSelection } from "./assistantOutputSelection";

function selectNodeContents(node: Node): Selection {
  const selection = window.getSelection();
  if (!selection) throw new Error("jsdom selection unavailable");
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("readAssistantOutputSelection", () => {
  it("returns trimmed text only when the range is inside assistant output", () => {
    const root = document.createElement("div");
    const assistant = document.createElement("div");
    assistant.dataset.assistantOutput = "true";
    assistant.textContent = "  highlighted passage  ";
    const user = document.createElement("div");
    user.textContent = "user prompt";
    root.append(assistant, user);
    document.body.append(root);

    const inside = readAssistantOutputSelection(root, selectNodeContents(assistant));
    expect(inside?.text).toBe("highlighted passage");

    const outside = readAssistantOutputSelection(root, selectNodeContents(user));
    expect(outside).toBeNull();
    root.remove();
  });

  it("returns null when a range spans assistant-output elements", () => {
    const root = document.createElement("div");
    const first = document.createElement("div");
    first.dataset.assistantOutput = "true";
    first.textContent = "first answer";
    const second = document.createElement("div");
    second.dataset.assistantOutput = "true";
    second.textContent = "second answer";
    root.append(first, second);
    document.body.append(root);

    const selection = window.getSelection();
    if (!selection) throw new Error("jsdom selection unavailable");
    const range = document.createRange();
    range.setStart(first.firstChild!, 0);
    range.setEnd(second.firstChild!, 6);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(readAssistantOutputSelection(root, selection)).toBeNull();
    root.remove();
  });
});
