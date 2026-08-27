import { describe, expect, it } from "vitest";

import {
  hasPluginActionComposerRequest,
  hasPluginActionDialogRequest,
  hasPluginActionOpenUrlRequest,
  hasPluginActionWebviewRequest,
  isPluginCollectionIfFull,
  PLUGIN_COLLECTION_IF_FULL_MODES,
  PLUGIN_COMPOSER_TEXT_MAX_BYTES,
  PLUGIN_DIALOG_FIELD_VALUE_MAX_BYTES,
  PLUGIN_NOTIFICATION_DEEPLINK_MAX_CHARS,
  PLUGIN_OPEN_URL_MAX_CHARS,
  PLUGIN_WEBVIEW_POINTER_MAX_BYTES,
  pluginCollectionPutParams,
  readPluginActionComposerEdit,
  readPluginActionDialogEdit,
  readPluginActionOpenUrl,
  readPluginActionWebview,
  readPluginNotificationDeeplink,
} from "./sdk";

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
