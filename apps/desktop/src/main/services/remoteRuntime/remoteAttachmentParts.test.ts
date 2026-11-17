import { describe, expect, it } from "vitest";
import { createAttachmentPartStore, type AttachmentPartStore } from "../chat/chatAttachmentParts";
import { sendAttachmentInParts } from "./remoteAttachmentParts";

function patterned(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 131 + 7) % 256;
  return bytes;
}

/** The machine's side: the real part store, staging into memory. */
function machine() {
  const staged: Buffer[] = [];
  const make = (): AttachmentPartStore => createAttachmentPartStore({
    maxBytes: 10 * 1024 * 1024,
    stage: async (content) => {
      staged.push(Buffer.from(content));
      return { path: `/attachments/${staged.length}.png` };
    },
  });
  return { staged, make };
}

const linkDropped = () => new Error("Remote ADE service connection interrupted.");
const noWait = async () => {};

describe("a paste sent in parts", () => {
  it.each([
    {
      name: "answers lost after the machine took the part",
      // The machine runs the part; the answer never comes back.
      link: (calls: number) => (calls % 3 === 2 ? "lose-answer" : "deliver"),
    },
    {
      name: "parts lost before they reached the machine",
      link: (calls: number) => (calls % 4 === 1 ? "lose-part" : "deliver"),
    },
    {
      name: "parts that arrive in reverse pairs",
      link: () => "deliver",
      reorder: true,
    },
  ])("stages the exact bytes once despite $name", async ({ link, reorder }) => {
    const bytes = patterned(700_000);
    const side = machine();
    const store = side.make();
    let calls = 0;
    let held: (() => void) | null = null;
    const saved = await sendAttachmentInParts({
      bytes,
      filename: "clipboard.png",
      sleep: noWait,
      call: async (part) => {
        calls += 1;
        const fate = link(calls);
        if (fate === "lose-part") throw linkDropped();
        if (reorder) {
          // The first of each pair waits for the second to be placed. The
          // last part may have no partner; it goes on its own after 20 ms.
          // Any order must give the same bytes, so the wait decides nothing.
          if (!held) {
            await new Promise<void>((resolve) => {
              held = resolve;
              setTimeout(() => {
                if (held === resolve) held = null;
                resolve();
              }, 20);
            });
          } else {
            const release = held;
            held = null;
            const answer = await store.savePart(part);
            release();
            return answer;
          }
        }
        const answer = await store.savePart(part);
        if (fate === "lose-answer") throw linkDropped();
        return answer;
      },
    });
    expect(saved.path).toBe("/attachments/1.png");
    expect(side.staged).toHaveLength(1);
    expect(side.staged[0]!.equals(bytes)).toBe(true);
  });

  it("sends again from the start when the machine restarted and lost the parts", async () => {
    const bytes = patterned(500_000);
    const side = machine();
    let store = side.make();
    let calls = 0;
    const saved = await sendAttachmentInParts({
      bytes,
      filename: "clipboard.png",
      sleep: noWait,
      call: async (part) => {
        calls += 1;
        // The machine restarts after the first part: what it held is gone,
        // and the parts after it land on a machine with no start.
        if (calls === 2) store = side.make();
        return await store.savePart(part);
      },
    });
    expect(saved.path).toBe("/attachments/1.png");
    expect(side.staged).toHaveLength(1);
    expect(side.staged[0]!.equals(bytes)).toBe(true);
  });

  it("gives up on a link that stays down, and fails at once on a refusal", async () => {
    const bytes = patterned(300_000);
    await expect(sendAttachmentInParts({
      bytes,
      filename: "clipboard.png",
      sleep: noWait,
      call: async () => {
        throw linkDropped();
      },
    })).rejects.toThrow(/connection interrupted/);

    let calls = 0;
    await expect(sendAttachmentInParts({
      bytes,
      filename: "clipboard.png",
      sleep: noWait,
      call: async () => {
        calls += 1;
        throw new Error("This attachment is larger than the machine accepts.");
      },
    })).rejects.toThrow(/larger than the machine accepts/);
    // One refused part per part in flight; no tries again.
    expect(calls).toBeLessThanOrEqual(2);
  });
});
