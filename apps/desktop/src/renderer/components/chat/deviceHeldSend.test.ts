import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AgentChatApi } from "./agentChatApi";
import { prepareDeviceHeldForSend } from "./deviceHeldSend";
import { holdAttachmentBytes, releaseHeldAttachments } from "./heldChatAttachments";

const PIN: OpenProjectBinding = { kind: "local", key: "machine-a", rootPath: "/work/widgets", displayName: "Studio" };

describe("prepareDeviceHeldForSend", () => {
  const heldPaths: string[] = [];
  afterEach(() => releaseHeldAttachments(heldPaths.splice(0)));

  const hold = (data: string, filename: string): string => {
    const path = holdAttachmentBytes({ data, filename, mimeType: "text/plain" });
    if (!path) throw new Error("no room to hold the file");
    heldPaths.push(path);
    return path;
  };

  it("a send whose second file fails sends nothing; its retry copies only that file and sends both machine paths in order", async () => {
    const first = hold("Zmlyc3Q=", "notes.txt");
    const second = hold("c2Vjb25k", "log.txt");
    let secondTries = 0;
    // The IPC boundary: the copy to the chat's machine. The second file fails the first time.
    const saveTempAttachment = vi.fn(async (file: { data: string; filename: string }, _pin: OpenProjectBinding) => {
      if (file.filename === "log.txt" && secondTries++ === 0) throw new Error("Error invoking remote method 'ade.agentChat.saveTempAttachment': Error: disk full");
      return { path: `/home/node/.ade/attachments/${file.filename}` };
    });
    const send = () => prepareDeviceHeldForSend({
      api: { saveTempAttachment } as unknown as AgentChatApi,
      sessionId: "chat-1",
      pin: PIN,
      attachments: [
        { path: first, type: "file" },
        { path: second, type: "file" },
      ],
      carriesComments: false,
      machineRests: true,
    });

    await expect(send()).rejects.toThrow("Not sent. ADE couldn't copy your files to the chat's computer.");

    await expect(send()).resolves.toEqual({
      attachments: [
        { path: "/home/node/.ade/attachments/notes.txt", type: "file" },
        { path: "/home/node/.ade/attachments/log.txt", type: "file" },
      ],
      stagedHeldPaths: [first, second],
      commentsHandedOver: false,
    });
    // Each file went to the chat's machine once, by its pin; the retry copied only the one that failed.
    expect(saveTempAttachment.mock.calls).toEqual([
      [{ data: "Zmlyc3Q=", filename: "notes.txt" }, PIN],
      [{ data: "c2Vjb25k", filename: "log.txt" }, PIN],
      [{ data: "c2Vjb25k", filename: "log.txt" }, PIN],
    ]);
  });
});
