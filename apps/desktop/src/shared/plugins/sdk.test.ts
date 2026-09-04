import { describe, expect, it } from "vitest";

import {
  PLUGIN_CHAT_DELIVERY_ACTION_PREFIX,
  PLUGIN_RESERVED_ACTION_PREFIX,
  isReservedPluginActionName,
  pluginChatDeliveryAction,
  readPluginChatDeliveryAction,
  reservedPluginActionMessage,
  hasPluginActionComposerRequest,
  hasPluginActionDialogRequest,
  hasPluginActionOpenUrlRequest,
  hasPluginActionPromptRequest,
  hasPluginActionWebviewRequest,
  isPluginCollectionIfFull,
  PLUGIN_COLLECTION_IF_FULL_MODES,
  PLUGIN_COMPOSER_TEXT_MAX_BYTES,
  PLUGIN_DIALOG_FIELD_VALUE_MAX_BYTES,
  PLUGIN_NOTIFICATION_DEEPLINK_MAX_CHARS,
  PLUGIN_OPEN_URL_MAX_CHARS,
  PLUGIN_PROMPT_TEXT_MAX_BYTES,
  PLUGIN_WEBVIEW_POINTER_MAX_BYTES,
  pluginCollectionPutParams,
  readPluginActionComposerEdit,
  buildPluginActionPromptAnswer,
  PLUGIN_ACTION_NAVIGATION_TARGETS,
  readPluginActionNavigation,
  readPluginActionPrompt,
  readPluginInvokeAction,
  pluginInvokeActionMissingMessage,
  readPluginActionDialogEdit,
  readPluginActionOpenUrl,
  readPluginActionOpenSettings,
  readPluginChatArtifactSourceUrl,
  hasPluginActionOpenSettingsRequest,
  PLUGIN_OPEN_SETTINGS_ENTRY_IDS,
  pluginOpenSettingsTarget,
  readPluginActionWebview,
  readPluginNotificationDeeplink,
  readPluginActionMessage,
} from "./sdk";
import { VOCAB_LIMITS } from "./vocabulary";

describe("collections.put wire shape", () => {
  it("puts nothing extra on the wire when no option was named", () => {
    // Byte-for-byte what a plugin written before `ifFull` existed sends, so a
    // newer plugin talking to an older host is indistinguishable from an old one.
    expect(JSON.stringify(pluginCollectionPutParams("cache", "a", { n: 1 })))
      .toBe(JSON.stringify({ collection: "cache", key: "a", value: { n: 1 } }));
    expect(JSON.stringify(pluginCollectionPutParams("cache", "a", { n: 1 }, {})))
      .toBe(JSON.stringify({ collection: "cache", key: "a", value: { n: 1 } }));
  });

  it("carries the option in its own frame when one was named", () => {
    expect(pluginCollectionPutParams("cache", "a", 1, { ifFull: "evictOldest" }))
      .toEqual({ collection: "cache", key: "a", value: 1, options: { ifFull: "evictOldest" } });
  });

  it("accepts exactly the declared modes", () => {
    for (const mode of PLUGIN_COLLECTION_IF_FULL_MODES) expect(isPluginCollectionIfFull(mode)).toBe(true);
    for (const value of ["evictoldest", "evict", "", null, undefined, 1, {}]) {
      expect(isPluginCollectionIfFull(value)).toBe(false);
    }
  });
});

describe("composer edits in an action response", () => {
  it("reads both verbs", () => {
    expect(readPluginActionComposerEdit({ composer: { insertText: "TODO: " } }))
      .toEqual({ mode: "insert", text: "TODO: " });
    expect(readPluginActionComposerEdit({ composer: { replaceText: "Rewrite the whole prompt." } }))
      .toEqual({ mode: "replace", text: "Rewrite the whole prompt." });
  });

  // "Replace, then insert into the replacement" is not what either verb means.
  it("takes the more total verb when a plugin sends both", () => {
    expect(readPluginActionComposerEdit({ composer: { insertText: "a", replaceText: "b" } }))
      .toEqual({ mode: "replace", text: "b" });
  });

  it("lets replace clear the draft but treats an empty insert as nothing to do", () => {
    expect(readPluginActionComposerEdit({ composer: { replaceText: "" } }))
      .toEqual({ mode: "replace", text: "" });
    expect(readPluginActionComposerEdit({ composer: { insertText: "" } })).toBeNull();
  });

  // Most action results carry no composer verb at all, so anything
  // unrecognizable is an absence rather than an error.
  it("is null for a result that says nothing about the composer", () => {
    for (const result of [null, undefined, 42, "text", {}, { composer: null }, { composer: "x" }]) {
      expect(readPluginActionComposerEdit(result)).toBeNull();
    }
  });

  it("drops rather than truncates text over the ceiling", () => {
    const tooLong = "x".repeat(PLUGIN_COMPOSER_TEXT_MAX_BYTES + 1);
    expect(readPluginActionComposerEdit({ composer: { insertText: tooLong } })).toBeNull();
    expect(readPluginActionComposerEdit({ composer: { replaceText: tooLong } })).toBeNull();
    // Measured in UTF-8 bytes, not characters: a multi-byte draft that fits as
    // a string can still be over the wire ceiling.
    const multibyte = "é".repeat(PLUGIN_COMPOSER_TEXT_MAX_BYTES / 2 + 1);
    expect(readPluginActionComposerEdit({ composer: { insertText: multibyte } })).toBeNull();
  });

  // A refusal and a silence look identical to the reader, and only the first is
  // worth telling the person wondering why the button did nothing.
  it("separates asking-and-being-refused from never asking", () => {
    expect(hasPluginActionComposerRequest({ composer: { insertText: "" } })).toBe(true);
    expect(hasPluginActionComposerRequest({ ok: true })).toBe(false);
    expect(hasPluginActionComposerRequest(null)).toBe(false);
  });
});

describe("dialog edits in an action response", () => {
  it("writes one allowlisted field of the dialog it was read for", () => {
    expect(readPluginActionDialogEdit({ dialog: { setField: { field: "name", value: "fix-auth" } } }, "create-lane"))
      .toEqual({ field: "name", value: "fix-auth" });
    expect(readPluginActionDialogEdit({ dialog: { setField: { field: "body", value: "Closes ISS-14" } } }, "create-pr"))
      .toEqual({ field: "body", value: "Closes ISS-14" });
  });

  /**
   * The allowlist is per dialog, and the only layer that knows which dialog is
   * open is the one holding it. A create-lane section returning a PR field is
   * not a partial success to filter downstream — it is an edit for a dialog the
   * user is not looking at.
   */
  it("refuses a field that belongs to a different dialog", () => {
    const result = { dialog: { setField: { field: "body", value: "..." } } };
    expect(readPluginActionDialogEdit(result, "create-lane")).toBeNull();
    expect(readPluginActionDialogEdit(result, "manage-lane")).toBeNull();
    expect(readPluginActionDialogEdit(result, "create-pr")).toEqual({ field: "body", value: "..." });
  });

  // Confirmation controls are not fields. A section that could arm the reclaim
  // phrase would leave the user one keystroke from confirming a delete.
  it("reaches no confirmation control, whatever the plugin names", () => {
    for (const field of ["reclaimConfirm", "discardDirtyConfirmed", "activeTab", "__proto__"]) {
      expect(readPluginActionDialogEdit({ dialog: { setField: { field, value: "yes" } } }, "manage-lane")).toBeNull();
    }
  });

  it("reads anything unrecognizable as no edit at all", () => {
    for (const result of [null, "nope", {}, { dialog: {} }, { dialog: { setField: {} } },
      { dialog: { setField: { field: "name" } } },
      { dialog: { setField: { field: "name", value: 7 } } }]) {
      expect(readPluginActionDialogEdit(result, "create-lane")).toBeNull();
    }
  });

  // Same rule as the composer: dropped, never truncated. A half-written branch
  // name that then gets created is worse than a field that stayed empty.
  it("drops an over-long value rather than truncating it", () => {
    const value = "x".repeat(PLUGIN_DIALOG_FIELD_VALUE_MAX_BYTES + 1);
    expect(readPluginActionDialogEdit({ dialog: { setField: { field: "body", value } } }, "create-pr")).toBeNull();
    const atLimit = "x".repeat(PLUGIN_DIALOG_FIELD_VALUE_MAX_BYTES);
    expect(readPluginActionDialogEdit({ dialog: { setField: { field: "body", value: atLimit } } }, "create-pr"))
      .toEqual({ field: "body", value: atLimit });
  });

  // "Said nothing" and "asked for something this dialog refused" are different
  // events, and only the second is worth telling anyone about.
  it("separates a refused request from no request at all", () => {
    expect(hasPluginActionDialogRequest({ dialog: { setField: { field: "body", value: "x" } } })).toBe(true);
    expect(hasPluginActionDialogRequest({ navigate: { panelId: "main" } })).toBe(false);
    expect(hasPluginActionDialogRequest({ dialog: {} })).toBe(false);
  });
});

describe("openWebview in an action response", () => {
  it("reads a surface id, and a pointer when it is present", () => {
    expect(readPluginActionWebview({ openWebview: { surfaceId: "mixer" } }))
      .toEqual({ surfaceId: "mixer" });
    expect(readPluginActionWebview({ openWebview: { surfaceId: "mixer", context: { drink: 4 } } }))
      .toEqual({ surfaceId: "mixer", context: { drink: 4 } });
  });

  it("drops anything that is not a plugin identifier for the surface id", () => {
    expect(readPluginActionWebview({ openWebview: { surfaceId: "" } })).toBeNull();
    expect(readPluginActionWebview({ openWebview: { surfaceId: "../escape" } })).toBeNull();
    expect(readPluginActionWebview({ openWebview: {} })).toBeNull();
    expect(readPluginActionWebview({ openWebview: 7 })).toBeNull();
    expect(readPluginActionWebview(null)).toBeNull();
  });

  // Same rule as navigate's context: over the ceiling drops the pointer and
  // keeps the open, because the user pressed a button and should still land on
  // the page it summoned.
  it("keeps the open but drops an over-large pointer", () => {
    const big = { blob: "x".repeat(PLUGIN_WEBVIEW_POINTER_MAX_BYTES + 1) };
    expect(readPluginActionWebview({ openWebview: { surfaceId: "mixer", context: big } }))
      .toEqual({ surfaceId: "mixer" });
  });

  it("separates a malformed request from no request at all", () => {
    expect(hasPluginActionWebviewRequest({ openWebview: { surfaceId: "" } })).toBe(true);
    expect(hasPluginActionWebviewRequest({ navigate: { panelId: "main" } })).toBe(false);
  });
});

describe("openUrl in an action response", () => {
  it("reads both shapes a plugin might write", () => {
    expect(readPluginActionOpenUrl({ openUrl: { url: "https://cursor.com/agents" } }))
      .toEqual({ url: "https://cursor.com/agents" });
    expect(readPluginActionOpenUrl({ openUrl: "  https://cursor.com/agents  " }))
      .toEqual({ url: "https://cursor.com/agents" });
  });

  // The whole point of the verb having a reader: a link is the one thing a
  // plugin returns that leaves ADE, and two of these schemes turn a link into
  // a local-file read or a script.
  it("opens https and refuses every other scheme", () => {
    for (const refused of [
      "http://cursor.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "ade://lane/abc",
      "//cursor.com/agents",
      "cursor.com/agents",
      "",
      "   ",
    ]) {
      expect(readPluginActionOpenUrl({ openUrl: refused }), `${refused} was allowed`).toBeNull();
    }
    // Case is not a way in: the parser lowercases a protocol before it is read.
    expect(readPluginActionOpenUrl({ openUrl: "HTTPS://cursor.com/agents" }))
      .toEqual({ url: "https://cursor.com/agents" });
    expect(readPluginActionOpenUrl({ openUrl: "JavaScript:alert(1)" })).toBeNull();
  });

  it("drops a URL past the ceiling rather than handing a system API a payload", () => {
    const long = `https://cursor.com/?q=${"x".repeat(PLUGIN_OPEN_URL_MAX_CHARS)}`;
    expect(readPluginActionOpenUrl({ openUrl: long })).toBeNull();
  });

  it("is null for a result that carries no link at all", () => {
    expect(readPluginActionOpenUrl({ navigate: { panelId: "main" } })).toBeNull();
    expect(readPluginActionOpenUrl({ openUrl: 7 })).toBeNull();
    expect(readPluginActionOpenUrl(null)).toBeNull();
  });

  it("separates a refused link from no link at all", () => {
    expect(hasPluginActionOpenUrlRequest({ openUrl: "file:///etc/passwd" })).toBe(true);
    expect(hasPluginActionOpenUrlRequest({ openUrl: { url: "x" } })).toBe(true);
    expect(hasPluginActionOpenUrlRequest({ navigate: { panelId: "main" } })).toBe(false);
    expect(hasPluginActionOpenUrlRequest(null)).toBe(false);
  });
});

describe("a deeplink on a plugin notification", () => {
  it("accepts a panel link the posting plugin owns", () => {
    expect(readPluginNotificationDeeplink("ade://plugin/acme/fleet", "acme"))
      .toBe("ade://plugin/acme/fleet");
    expect(readPluginNotificationDeeplink('  ade://plugin/acme/fleet?ctx={"id":"bc-1"}  ', "acme"))
      .toBe('ade://plugin/acme/fleet?ctx={"id":"bc-1"}');
  });

  // A notification is the one thing a plugin puts in front of the user outside
  // ADE's window, and the link in it is the one thing they tap without reading.
  it("refuses a link to anywhere but the posting plugin's own panels", () => {
    for (const refused of [
      "ade://plugin/other/fleet",
      "ade://lane/lane-1",
      "ade://plugin/acme",
      "ade://plugin/acme/fleet/extra",
      "ade://plugin/acme/../escape",
      "https://cursor.com/agents",
      "javascript:alert(1)",
      "not a url",
      "",
      7,
      null,
    ]) {
      expect(readPluginNotificationDeeplink(refused, "acme"), `${String(refused)} was allowed`)
        .toBeNull();
    }
  });

  it("drops a link long enough to blow the push payload", () => {
    const long = `ade://plugin/acme/fleet?ctx=${"x".repeat(PLUGIN_NOTIFICATION_DEEPLINK_MAX_CHARS)}`;
    expect(readPluginNotificationDeeplink(long, "acme")).toBeNull();
  });
});

describe("reserved chat-delivery action names", () => {
  it("round-trips the two reliable chat events", () => {
    expect(pluginChatDeliveryAction("chat.turn")).toBe("ade:chat.turn");
    expect(pluginChatDeliveryAction("chat.interrupt")).toBe("ade:chat.interrupt");
    expect(readPluginChatDeliveryAction("ade:chat.turn")).toBe("chat.turn");
    expect(readPluginChatDeliveryAction("ade:chat.interrupt")).toBe("chat.interrupt");
  });

  it("reads a plugin's own action as not-a-delivery", () => {
    // The child consults this BEFORE its handler map, so anything that is not
    // one of the two reserved names must fall through to the plugin.
    expect(readPluginChatDeliveryAction("openIssue")).toBeNull();
    expect(readPluginChatDeliveryAction("ade-cursor-cloud")).toBeNull();
    // Inside the reserved namespace but not a delivery: the host's invoke door
    // refuses this name outright, so it can never reach a child at all.
    expect(readPluginChatDeliveryAction("ade:chat.opened")).toBeNull();
    expect(readPluginChatDeliveryAction("ade:")).toBeNull();
  });

  it("reserves the whole prefix, not just the two names in use", () => {
    // A later reserved verb must not be squattable before it ships.
    expect(PLUGIN_RESERVED_ACTION_PREFIX).toBe(PLUGIN_CHAT_DELIVERY_ACTION_PREFIX);
    expect(isReservedPluginActionName("ade:chat.opened")).toBe(true);
    expect(isReservedPluginActionName("ade:something-not-invented-yet")).toBe(true);
    expect(isReservedPluginActionName("ADE:CHAT.TURN")).toBe(true);
    expect(isReservedPluginActionName(" ade:chat.turn ")).toBe(true);
  });

  it("does not reserve a name that merely starts with the letters", () => {
    for (const name of ["ade", "adept", "ade-cursor-cloud", "adeChat", "openIssue"]) {
      expect(isReservedPluginActionName(name), name).toBe(false);
    }
    expect(isReservedPluginActionName(null)).toBe(false);
    expect(isReservedPluginActionName(42)).toBe(false);
  });

  it("names the prefix in its refusal, so an author can see the rule", () => {
    expect(reservedPluginActionMessage("ade:chat.turn")).toContain("ade:");
    expect(reservedPluginActionMessage("ade:chat.turn")).toContain("reserved");
  });
});

/**
 * The navigate verb, and the one field on it that four clients read differently.
 *
 * `target` is the only part of a plugin's answer that names a PLACE rather than
 * a thing, and only the desktop has more than one place to put a panel. So the
 * contract is that it is optional, that an unknown value drops without taking
 * the navigation with it, and that a client which cannot honour it still lands
 * the reader on the panel. The terminal client shares this exact reader
 * (`tuiClient/app.tsx` imports it), and iOS decodes `PluginInvokeNavigation`
 * through a keyed container over `panelId` and `context` only, so an unknown key
 * is ignored by construction there.
 */
describe("action navigation", () => {
  it("reads a bare panel navigation, with no placement of its own", () => {
    expect(readPluginActionNavigation({ navigate: { panelId: "stories" } }))
      .toEqual({ panelId: "stories" });
  });

  it("carries an explicit placement through", () => {
    expect(readPluginActionNavigation({ navigate: { panelId: "stories", target: "tools-pane" } }))
      .toEqual({ panelId: "stories", target: "tools-pane" });
    expect(readPluginActionNavigation({ navigate: { panelId: "stories", target: "tab" } }))
      .toEqual({ panelId: "stories", target: "tab" });
  });

  it("drops a placement it does not recognize and keeps the navigation", () => {
    // A plugin naming a place a future ADE has must still open its panel here.
    for (const target of ["drawer", "", 7, null, {}]) {
      expect(readPluginActionNavigation({ navigate: { panelId: "stories", target } }))
        .toEqual({ panelId: "stories" });
    }
  });

  it("keeps the placement beside a context, and beside a dropped one", () => {
    expect(readPluginActionNavigation({
      navigate: { panelId: "stories", target: "tools-pane", context: { feed: "ask" } },
    })).toEqual({ panelId: "stories", context: { feed: "ask" }, target: "tools-pane" });
    // Over the 2 KiB ceiling the context goes and the placement stays: the
    // reader still pressed a button that named where to open.
    expect(readPluginActionNavigation({
      navigate: { panelId: "stories", target: "tools-pane", context: { blob: "x".repeat(4096) } },
    })).toEqual({ panelId: "stories", target: "tools-pane" });
  });

  it("still refuses a navigation with no usable panel id", () => {
    expect(readPluginActionNavigation({ navigate: { target: "tools-pane" } })).toBeNull();
    expect(readPluginActionNavigation({ navigate: { panelId: "not a panel id" } })).toBeNull();
    expect(readPluginActionNavigation({ message: "done" })).toBeNull();
  });

  it("accepts the popover placement", () => {
    expect(readPluginActionNavigation({ navigate: { panelId: "stories", target: "popover" } }))
      .toEqual({ panelId: "stories", target: "popover" });
    expect(readPluginActionNavigation({
      navigate: { panelId: "stories", target: "popover", context: { feed: "ask" } },
    })).toEqual({ panelId: "stories", context: { feed: "ask" }, target: "popover" });
    expect(PLUGIN_ACTION_NAVIGATION_TARGETS).toContain("popover");
  });

  it("refuses a popover with no panel id, like every other placement", () => {
    // A placement is not an address. There is nothing for the popover to draw
    // without a panel, so the whole navigation goes rather than opening an
    // empty card at the button.
    expect(readPluginActionNavigation({ navigate: { target: "popover" } })).toBeNull();
    expect(readPluginActionNavigation({ navigate: { panelId: "", target: "popover" } })).toBeNull();
    expect(readPluginActionNavigation({ navigate: { panelId: "Not A Panel", target: "popover" } }))
      .toBeNull();
  });
});

describe("action openSettings", () => {
  it("reads both shapes a plugin might write", () => {
    expect(readPluginActionOpenSettings({ openSettings: "agents.provider.cursor" }))
      .toEqual({ kind: "entry", entryId: "agents.provider.cursor" });
    expect(readPluginActionOpenSettings({ openSettings: { entryId: "agents.provider.cursor" } }))
      .toEqual({ kind: "entry", entryId: "agents.provider.cursor" });
    expect(readPluginActionOpenSettings({ openSettings: "secrets.secrets" }))
      .toEqual({ kind: "entry", entryId: "secrets.secrets" });
  });

  it("drops an id this build has never heard of", () => {
    expect(readPluginActionOpenSettings({ openSettings: "billing.plans" })).toBeNull();
    expect(readPluginActionOpenSettings({ openSettings: { entryId: "agents.providers" } })).toBeNull();
    expect(readPluginActionOpenSettings({ openSettings: 7 })).toBeNull();
    expect(hasPluginActionOpenSettingsRequest({ openSettings: "billing.plans" })).toBe(true);
    expect(hasPluginActionOpenSettingsRequest({ message: "done" })).toBe(false);
  });

  it("reads the plugin's own settings section by socket id", () => {
    expect(readPluginActionOpenSettings({ openSettings: { socketId: "connection" } }))
      .toEqual({ kind: "socket", socketId: "connection" });
    expect(readPluginActionOpenSettings({ openSettings: { socketId: "team-defaults" } }))
      .toEqual({ kind: "socket", socketId: "team-defaults" });
  });

  it("refuses a socket id no manifest could have declared", () => {
    // The manifest's own identifier rule: no spaces, no `ade:` namespace, no
    // more than 64 characters, and a string in the first place.
    for (const socketId of ["not a socket id", "", "ade:connection", "x".repeat(65), 7, null, {}]) {
      expect(readPluginActionOpenSettings({ openSettings: { socketId } })).toBeNull();
    }
    // Still an ASK, so the caller says so out loud rather than leaving a button
    // that appears to do nothing.
    expect(hasPluginActionOpenSettingsRequest({ openSettings: { socketId: "Nope!" } })).toBe(true);
  });

  it("prefers a known entry id when a payload carries both", () => {
    // The closed half wins: it is the older shape and its answer cannot depend
    // on what the plugin happens to have published.
    expect(readPluginActionOpenSettings({
      openSettings: { entryId: "secrets.secrets", socketId: "connection" },
    })).toEqual({ kind: "entry", entryId: "secrets.secrets" });
    // An entry id this build does not know falls through to the socket half
    // rather than taking the whole request down.
    expect(readPluginActionOpenSettings({
      openSettings: { entryId: "billing.plans", socketId: "connection" },
    })).toEqual({ kind: "socket", socketId: "connection" });
  });

  it("maps every allowed id to a settings tab and anchor", () => {
    for (const entryId of PLUGIN_OPEN_SETTINGS_ENTRY_IDS) {
      const target = pluginOpenSettingsTarget(entryId);
      expect(target.tab.length).toBeGreaterThan(0);
      expect(target.anchor.length).toBeGreaterThan(0);
    }
  });
});

describe("plugin.invoke action name", () => {
  it("reads either spelling, preferring the canonical one", () => {
    expect(readPluginInvokeAction({ action: "openStories" })).toBe("openStories");
    expect(readPluginInvokeAction({ actionId: "openStories" })).toBe("openStories");
    expect(readPluginInvokeAction({ action: "wins", actionId: "loses" })).toBe("wins");
  });

  it("treats a blank or non-string value as absent under both names", () => {
    for (const args of [{}, { action: "" }, { action: "  " }, { actionId: 7 }, null, "openStories"]) {
      expect(readPluginInvokeAction(args)).toBeNull();
    }
  });

  it("names both spellings in the refusal", () => {
    expect(pluginInvokeActionMissingMessage()).toContain('"action"');
    expect(pluginInvokeActionMissingMessage()).toContain('"actionId"');
  });
});

describe("a prompt in an action response", () => {
  it("reads the whole question and hands the pointer back untouched", () => {
    expect(readPluginActionPrompt({
      prompt: {
        id: "note",
        title: "What are you working on?",
        placeholder: "One line",
        submitLabel: "Log",
        context: { lane: "plugin-platform" },
      },
    })).toEqual({
      id: "note",
      title: "What are you working on?",
      placeholder: "One line",
      submitLabel: "Log",
      context: { lane: "plugin-platform" },
    });
  });

  it("keeps the question when the copy is unusable, because the field is the point", () => {
    expect(readPluginActionPrompt({
      prompt: { id: "note", title: "t".repeat(500), placeholder: 7, submitLabel: "   " },
    })).toEqual({ id: "note" });
  });

  it("drops an over-ceiling pointer and still asks", () => {
    expect(readPluginActionPrompt({ prompt: { id: "note", context: { blob: "x".repeat(4096) } } }))
      .toEqual({ id: "note" });
  });

  it("reads closed options as a picker, skipping junk and capping the list", () => {
    expect(readPluginActionPrompt({
      prompt: {
        id: "lane",
        options: [
          { value: "a", label: "First" },
          { value: "a", label: "Dup" },
          { value: "" },
          7,
          { value: "b" },
        ],
      },
    })).toEqual({
      id: "lane",
      options: [{ value: "a", label: "First" }, { value: "b" }],
    });
    expect(readPluginActionPrompt({ prompt: { id: "lane", options: [] } })).toEqual({ id: "lane" });
    const tooMany = Array.from({ length: VOCAB_LIMITS.maxSelectOptions + 1 }, (_, i) => ({
      value: `lane-${i}`,
    }));
    expect(readPluginActionPrompt({ prompt: { id: "lane", options: tooMany } })?.options)
      .toHaveLength(VOCAB_LIMITS.maxSelectOptions);
  });

  it("refuses a prompt with no usable id, since the answer would be unattributable", () => {
    expect(readPluginActionPrompt({ prompt: { title: "What?" } })).toBeNull();
    expect(readPluginActionPrompt({ prompt: { id: "not an id" } })).toBeNull();
    expect(readPluginActionPrompt({ message: "done" })).toBeNull();
    expect(readPluginActionPrompt(null)).toBeNull();
  });

  it("separates asking badly from not asking, so a refusal can be logged", () => {
    expect(hasPluginActionPromptRequest({ prompt: { title: "What?" } })).toBe(true);
    expect(hasPluginActionPromptRequest({ message: "done" })).toBe(false);
  });

  it("builds the re-invocation frame, carrying the pointer and an empty answer", () => {
    const prompt = { id: "note", context: { lane: "main" } };
    expect(buildPluginActionPromptAnswer(prompt, "wrote the ledger"))
      .toEqual({ id: "note", text: "wrote the ledger", context: { lane: "main" } });
    expect(buildPluginActionPromptAnswer({ id: "note" }, ""))
      .toEqual({ id: "note", text: "" });
  });

  it("refuses an answer over the ceiling rather than saving half of it", () => {
    const tooLong = "x".repeat(PLUGIN_PROMPT_TEXT_MAX_BYTES + 1);
    expect(buildPluginActionPromptAnswer({ id: "note" }, tooLong)).toBeNull();
    // Measured in BYTES, so a field of multi-byte characters fills sooner than
    // its character count suggests — the same rule the composer verb uses.
    const multiByte = "é".repeat(PLUGIN_PROMPT_TEXT_MAX_BYTES / 2 + 1);
    expect(buildPluginActionPromptAnswer({ id: "note" }, multiByte)).toBeNull();
  });
});

describe("readPluginActionMessage", () => {
  it("treats a bare string as a successful outcome", () => {
    expect(readPluginActionMessage("Created lane 'x'.")).toEqual({
      text: "Created lane 'x'.",
      ok: true,
    });
  });

  it("treats { ok, message } as an envelope even when extra keys ride along", () => {
    expect(readPluginActionMessage({
      ok: true,
      message: "Lane created.",
      sessionId: "sess-1",
    })).toEqual({ text: "Lane created.", ok: true });
    expect(readPluginActionMessage({
      ok: false,
      message: "That model is unknown.",
    })).toEqual({ text: "That model is unknown.", ok: false });
  });

  it("toasts a message-only envelope that carries no other keys", () => {
    expect(readPluginActionMessage({ message: "Copied." })).toEqual({
      text: "Copied.",
      ok: true,
    });
  });

  it("does not toast a data payload that happens to have a message field", () => {
    // History's pageCommitDetail: the commit body, not an outcome sentence.
    expect(readPluginActionMessage({
      commit: { sha: "abc" },
      message: "fix the auth fallback",
      files: [],
    })).toBeNull();
  });

  it("is silent when there is no sentence", () => {
    expect(readPluginActionMessage({ ok: true })).toBeNull();
    expect(readPluginActionMessage({ navigate: { panelId: "main" } })).toBeNull();
    expect(readPluginActionMessage(null)).toBeNull();
    expect(readPluginActionMessage("   ")).toBeNull();
  });
});

describe("chat.setArtifacts sourceUrl", () => {
  it("accepts https and refuses loopback", () => {
    expect(readPluginChatArtifactSourceUrl("https://files.cursor.com/a.bin"))
      .toBe("https://files.cursor.com/a.bin");
    expect(readPluginChatArtifactSourceUrl("http://files.cursor.com/a.bin")).toBeUndefined();
    expect(readPluginChatArtifactSourceUrl("https://localhost/a.bin")).toBeUndefined();
    expect(readPluginChatArtifactSourceUrl("https://user:pass@files.cursor.com/a.bin")).toBeUndefined();
  });
});
