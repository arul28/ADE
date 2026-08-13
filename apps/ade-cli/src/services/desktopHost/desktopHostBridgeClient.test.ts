import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { JsonRpcClient } from "../../tuiClient/jsonRpcClient";
import { startBuiltInBrowserDesktopBridgeServer } from "../../../../desktop/src/main/services/builtInBrowser/desktopBridgeServer";
import type { BuiltInBrowserService } from "../../../../desktop/src/main/services/builtInBrowser/builtInBrowserService";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { PluginSdkError } from "../../../../desktop/src/shared/plugins/sdk";
import { BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM } from "../builtInBrowser/desktopBridgeMethods";
import { createDesktopHostBridge } from "./desktopHostBridgeClient";
import {
  decodeDesktopHostError,
  encodeDesktopHostError,
  DESKTOP_CLIPBOARD_READ_METHOD,
  DESKTOP_NOTIFY_METHOD,
  DESKTOP_NOTIFY_REQUESTER_LABEL_MAX_CHARS,
} from "./desktopHostBridge";

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PluginSdkError) return error.code;
    throw error;
  }
  throw new Error("Expected the bridge to refuse this call.");
}

describe("desktop host error encoding", () => {
  it("round-trips a code through the one field JsonRpcClient preserves", () => {
    // The code rides in the message because `JsonRpcClient` rebuilds a
    // rejection from `error.message` alone and drops `data`.
    const encoded = encodeDesktopHostError("dialog_cancelled", "The picker was dismissed.");

    expect(decodeDesktopHostError(encoded)).toEqual({
      code: "dialog_cancelled",
      message: "The picker was dismissed.",
    });
  });

  it("reads an ordinary message as no code at all", () => {
    // A genuine crash must reach the plugin as a failure, not be dressed up as
    // an outcome the user caused.
    expect(decodeDesktopHostError("socket hang up")).toBeNull();
    expect(decodeDesktopHostError("EPIPE: broken pipe")).toBeNull();
  });
});

describe("createDesktopHostBridge without a desktop", () => {
  it("refuses every verb with desktop_unavailable when no credential was handed over", async () => {
    const bridge = createDesktopHostBridge({
      socketPath: path.join(os.tmpdir(), "ade-missing.sock"),
      getAuthToken: () => null,
      logger: silentLogger(),
    });

    // The daemon holds this credential only while a desktop has handed it
    // over, so an absent one means nothing that owns these APIs is attached.
    expect(await codeOf(() => bridge.readClipboard())).toBe("desktop_unavailable");
    expect(await codeOf(() => bridge.writeClipboard("x"))).toBe("desktop_unavailable");
    expect(await codeOf(() => bridge.pickFile({}))).toBe("desktop_unavailable");
    expect(await codeOf(() => bridge.notify({ title: "t", requesterLabel: "Graph" })))
      .toBe("desktop_unavailable");
  });

  it("refuses when the socket file is gone", async () => {
    const bridge = createDesktopHostBridge({
      socketPath: path.join(os.tmpdir(), `ade-gone-${randomUUID()}.sock`),
      getAuthToken: () => "token",
      logger: silentLogger(),
    });

    expect(await codeOf(() => bridge.readClipboard())).toBe("desktop_unavailable");
  });
});

describe.skipIf(process.platform === "win32")("desktop bridge host capabilities", () => {
  let bridgeServer: ReturnType<typeof startBuiltInBrowserDesktopBridgeServer> | null = null;
  let socketDir: string | null = null;

  afterEach(() => {
    bridgeServer?.dispose();
    bridgeServer = null;
    if (socketDir) {
      fs.rmSync(socketDir, { recursive: true, force: true });
      socketDir = null;
    }
  });

  type Capabilities = NonNullable<
    Parameters<typeof startBuiltInBrowserDesktopBridgeServer>[0]["hostCapabilities"]
  >;

  const startBridge = (hostCapabilities?: Partial<Capabilities>): string => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-host-e2e-"));
    const socketPath = path.join(socketDir, "desktop-bridge.sock");
    bridgeServer = startBuiltInBrowserDesktopBridgeServer({
      socketPath,
      service: {} as unknown as BuiltInBrowserService,
      logger: silentLogger(),
      ...(hostCapabilities
        ? {
          hostCapabilities: {
            readClipboard: () => "",
            writeClipboard: () => {},
            pickFile: async () => null,
            notify: () => true,
            ...hostCapabilities,
          },
        }
        : {}),
    });
    return socketPath;
  };

  const waitForSocket = async (socketPath: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (fs.existsSync(socketPath)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Bridge socket never appeared at ${socketPath}`);
  };

  const connect = async (socketPath: string) => {
    await waitForSocket(socketPath);
    return createDesktopHostBridge({
      socketPath,
      getAuthToken: () => bridgeServer!.authToken,
      logger: silentLogger(),
    });
  };

  it("round-trips the clipboard through the real server", async () => {
    let written: string | null = null;
    const socketPath = startBridge({
      readClipboard: () => "copied text",
      writeClipboard: (text) => {
        written = text;
      },
    });
    const bridge = await connect(socketPath);

    expect(await bridge.readClipboard()).toBe("copied text");
    await bridge.writeClipboard("from a plugin");

    expect(written).toBe("from a plugin");
  });

  it("returns a path from the picker and turns a dismissal into dialog_cancelled", async () => {
    const socketPath = startBridge({ pickFile: async () => "/tmp/chosen.txt" });
    const bridge = await connect(socketPath);

    expect(await bridge.pickFile({ title: "Pick one" })).toBe("/tmp/chosen.txt");

    bridgeServer?.dispose();
    const cancelledSocket = startBridge({ pickFile: async () => null });
    const cancelledBridge = await connect(cancelledSocket);

    // A dismissal is an outcome, not a fault: the plugin must be able to tell
    // it from a desktop that fell over.
    expect(await codeOf(() => cancelledBridge.pickFile({}))).toBe("dialog_cancelled");
  });

  it("strips a leading dot from picker extensions, accepting both spellings", async () => {
    let seen: { name: string; extensions: string[] }[] | undefined;
    const socketPath = startBridge({
      pickFile: async (input) => {
        seen = input.filters;
        return "/tmp/clip.mp4";
      },
    });
    const bridge = await connect(socketPath);

    await bridge.pickFile({ filters: [{ name: "Video", extensions: [".mp4", "mp4"] }] });

    // Electron wants extensions WITHOUT a leading dot, but the manifest's
    // `file-viewer` field — and the skill that documents it — use the
    // identically-named field WITH one. An author who copies the dotted
    // spelling would otherwise get `*..mp4` in the Windows dialog: a filter
    // matching nothing, with no way out of it. Both spellings must arrive the
    // same, so neither is a trap.
    expect(seen).toEqual([{ name: "Video", extensions: ["mp4", "mp4"] }]);
  });

  it("drops a filter left with no usable extension rather than sending an empty one", async () => {
    let seen: unknown = "untouched";
    const socketPath = startBridge({
      pickFile: async (input) => {
        seen = input.filters;
        return "/tmp/anything";
      },
    });
    const bridge = await connect(socketPath);

    await bridge.pickFile({ filters: [{ name: "X", extensions: ["."] }] });

    // A bare "." normalizes to "", and an empty extension is its own broken
    // dialog. The whole entry goes, and with nothing left the request carries
    // no `filters` at all — which is the same as never asking for one.
    expect(seen).toBeUndefined();
  });

  it("forwards the requester label to the notification, bounded", async () => {
    const seen: { title: string; body?: string; requesterLabel?: string }[] = [];
    const socketPath = startBridge({
      notify: (input) => {
        seen.push(input);
        return true;
      },
    });
    const bridge = await connect(socketPath);

    expect(await bridge.notify({ title: "Build failed", body: "3 tests", requesterLabel: "Graph" }))
      .toBe(true);
    await bridge.notify({ title: "x", requesterLabel: "L".repeat(200) });

    expect(seen[0]).toMatchObject({ title: "Build failed", body: "3 tests", requesterLabel: "Graph" });
    // The label comes from a third party's manifest, which the parser accepts
    // at any length; this hop is where that stops being unbounded.
    expect(seen[1]?.requesterLabel).toHaveLength(DESKTOP_NOTIFY_REQUESTER_LABEL_MAX_CHARS);
  });

  it("reports a desktop that cannot show a notification rather than claiming it did", async () => {
    const socketPath = startBridge({ notify: () => false });
    const bridge = await connect(socketPath);

    expect(await bridge.notify({ title: "t", requesterLabel: "Graph" })).toBe(false);
  });

  it("refuses every host capability when the bridge was started without them", async () => {
    const socketPath = startBridge();
    const bridge = await connect(socketPath);

    // A bridge wired without the capability answers a typed refusal rather
    // than accepting a method it cannot perform.
    expect(await codeOf(() => bridge.readClipboard())).toBe("desktop_unavailable");
    expect(await codeOf(() => bridge.pickFile({}))).toBe("desktop_unavailable");
  });

  it("refuses an unauthenticated caller on the host methods too", async () => {
    const socketPath = startBridge({ readClipboard: () => "secret" });
    await waitForSocket(socketPath);
    const raw = await JsonRpcClient.connect(socketPath);

    try {
      // The easy mistake is dispatching a new method above the auth check.
      await expect(raw.request(DESKTOP_CLIPBOARD_READ_METHOD, {})).rejects.toThrow(/authentication/i);
      await expect(
        raw.request(DESKTOP_NOTIFY_METHOD, { title: "t", [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: "wrong" }),
      ).rejects.toThrow(/authentication/i);
    } finally {
      raw.close();
    }
  });

  it("fails rather than hanging when the desktop dies mid-call", async () => {
    const socketPath = startBridge({
      readClipboard: () => {
        bridgeServer?.dispose();
        throw new Error("desktop quit");
      },
    });
    const bridge = await connect(socketPath);

    expect(await codeOf(() => bridge.readClipboard())).toBe("desktop_unavailable");
  });
});
