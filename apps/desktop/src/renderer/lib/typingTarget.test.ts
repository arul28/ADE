/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { isTypingTarget } from "./typingTarget";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isTypingTarget", () => {
  it("is true for the three things a person types into", () => {
    document.body.innerHTML = `
      <input id="input" />
      <textarea id="textarea"></textarea>
      <div id="rich" contenteditable="true"></div>
      <button id="button">Find</button>
    `;
    expect(isTypingTarget(document.getElementById("input"))).toBe(true);
    expect(isTypingTarget(document.getElementById("textarea"))).toBe(true);
    // jsdom does not implement `isContentEditable`, so the attribute alone
    // proves nothing here — the property is what the helper reads.
    const rich = document.getElementById("rich") as HTMLElement;
    Object.defineProperty(rich, "isContentEditable", { value: true });
    expect(isTypingTarget(rich)).toBe(true);
    expect(isTypingTarget(document.getElementById("button"))).toBe(false);
  });

  it("counts anything inside a declared escape scope, buttons included", () => {
    // The find bar's own next/previous buttons: a global single-key chord that
    // fired there would act on a surface that has claimed the keyboard.
    document.body.innerHTML = `
      <div data-ade-escape-scope="find"><button id="next">Next match</button></div>
      <button id="outside">More</button>
    `;
    expect(isTypingTarget(document.getElementById("next"))).toBe(true);
    expect(isTypingTarget(document.getElementById("outside"))).toBe(false);
  });

  it("is false for a target that is not an element at all", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(document)).toBe(false);
  });
});
