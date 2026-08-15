import { describe, expect, it } from "vitest";

import {
  PLUGIN_SKILL_NEXT_TURN_NOTE,
  describePluginClientRendering,
  formatPluginClientRendering,
} from "./clientRendering";
import {
  PLUGIN_SOCKET_CLIENT_SUPPORT,
  PLUGIN_SOCKET_KINDS,
  type PluginClientSurface,
  type PluginSocketKind,
} from "./sockets";

/**
 * The point of these is that the answer is DERIVED. Every expectation below
 * either reads the support table itself or asserts a shape, so a parity pass
 * that teaches a client a new kind does not have to come back and edit a
 * hand-written list here — and cannot make this file lie about what ships.
 */

function answerFor(
  kinds: readonly PluginSocketKind[],
  client: PluginClientSurface,
) {
  const answer = describePluginClientRendering(kinds).find((entry) => entry.client === client);
  if (!answer) throw new Error(`no answer for ${client}`);
  return answer;
}

describe("describePluginClientRendering", () => {
  it("splits declared kinds by what each client draws, from the support table", () => {
    for (const kind of PLUGIN_SOCKET_KINDS) {
      for (const answer of describePluginClientRendering([kind])) {
        const drawn = PLUGIN_SOCKET_CLIENT_SUPPORT[kind][answer.client];
        expect(answer.drawn).toEqual(drawn ? [kind] : []);
        expect(answer.absent).toEqual(drawn ? [] : [kind]);
        expect(answer.renders).toBe(drawn);
      }
    }
  });

  it("reports a client that draws some of a plugin's kinds and not others", () => {
    // A plugin whose composer button reaches the phone and whose slash command
    // does not — the exact shape the Tipsy alpha test hit.
    const partial = answerFor(["composer-action", "slash-command"], "ios");
    expect(partial.drawn).toEqual(["composer-action"]);
    expect(partial.absent).toEqual(["slash-command"]);
    expect(partial.renders).toBe(true);
  });

  it("collapses duplicates and answers in taxonomy order", () => {
    const answer = answerFor(["chat-card", "composer-action", "chat-card"], "desktop");
    expect(answer.drawn).toEqual(["composer-action", "chat-card"]);
  });

  it("answers for every client, even one that draws nothing", () => {
    const answers = describePluginClientRendering(["slash-command"]);
    expect(answers.map((entry) => entry.client)).toEqual(["desktop", "web", "ios", "tui"]);
    expect(answerFor(["slash-command"], "tui").renders).toBe(false);
  });
});

describe("formatPluginClientRendering", () => {
  it("names the drawn kinds, and says why the missing ones are missing", () => {
    const line = formatPluginClientRendering(
      describePluginClientRendering(["composer-action", "chat-card", "slash-command"]),
    );
    expect(line).toContain("desktop ✓ (composer-action, chat-card, slash-command)");
    expect(line).toContain("iPhone ✓ composer-action, chat-card / ✗ slash-command (not drawn on phones)");
    expect(line).toContain("terminal ✗");
    expect(line.startsWith("Renders on: ")).toBe(true);
  });

  it("counts rather than lists once a plugin declares more kinds than fit", () => {
    const line = formatPluginClientRendering(
      describePluginClientRendering([
        "toolbar-action",
        "row-badge",
        "row-menu-item",
        "detail-section",
        "empty-state",
      ]),
    );
    expect(line).toContain("desktop ✓ (toolbar-action, row-badge, row-menu-item +2 more)");
  });

  it("says nothing at all for a plugin that asks for no place", () => {
    expect(formatPluginClientRendering(describePluginClientRendering([]))).toBe("");
  });
});

describe("PLUGIN_SKILL_NEXT_TURN_NOTE", () => {
  it("promises the next turn and protects the running one", () => {
    expect(PLUGIN_SKILL_NEXT_TURN_NOTE).toBe(
      "Affects agents from their next turn — running turns keep their current behavior.",
    );
  });
});
