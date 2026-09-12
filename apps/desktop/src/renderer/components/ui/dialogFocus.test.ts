/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { getFocusableElements } from "./dialogFocus";

/**
 * One list for every dialog in the app. These are the cases the two traps used
 * to disagree about before they shared this module.
 */

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("getFocusableElements", () => {
  it("includes a <summary>, which a dialog can otherwise tab straight past", () => {
    const root = mount(`
      <button id="first">First</button>
      <details><summary id="more">More</summary><button id="inside">Inside</button></details>
    `);
    expect(getFocusableElements(root).map((node) => node.id)).toEqual(["first", "more"]);
  });

  it("opens up the contents of an open <details>", () => {
    const root = mount(`
      <details open><summary id="more">More</summary><input id="prompt" /></details>
    `);
    expect(getFocusableElements(root).map((node) => node.id)).toEqual(["more", "prompt"]);
  });

  it("skips hidden, aria-hidden and disabled controls", () => {
    const root = mount(`
      <button id="ok">OK</button>
      <div hidden><button id="hidden-child">Hidden</button></div>
      <div aria-hidden="true"><a id="decorative" href="#">Decorative</a></div>
      <button id="off" disabled>Off</button>
      <span id="untabbable" tabindex="-1">Untabbable</span>
    `);
    expect(getFocusableElements(root).map((node) => node.id)).toEqual(["ok"]);
  });
});
