import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentChatFileRef } from "../../../shared/types";
import { copyLaunchFilesFromSource, launchFileName } from "./cloudLaunchFileCopies";

/**
 * An ADE Cloud launch from this computer, with files the composer saved on the
 * machine the project is open on: each image is read from that machine, so the
 * file at the same path here (another file, or none) is never what goes up.
 */
describe("ADE Cloud launch files from another machine", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  type File = {
    /** Relative to a scratch root, the same on both machines. */
    at: string;
    type: "image" | "file";
    /** Bytes at that path on this computer, if any. */
    here?: string;
    /** Bytes the other machine sends back, if it has the image; with the type it sends. */
    there?: { bytes: string; mime?: string };
  };
  type Expected =
    | { copies: Array<{ at: string; bytes: string; uploadName: string }> }
    | { throws: RegExp };

  it.each<[string, File[], Expected]>([
    [
      "an image that is there and a different file at the same path here: the other machine's bytes go up",
      [{ at: "shots/screen.png", type: "image", here: "an old screenshot here", there: { bytes: "the screenshot there" } }],
      { copies: [{ at: "shots/screen.png", bytes: "the screenshot there", uploadName: "screen.png" }] },
    ],
    [
      "an image attached from this computer (the other machine doesn't have it): the file here, no copy",
      [{ at: "mine.png", type: "image", here: "attached here" }],
      { copies: [] },
    ],
    [
      "an image on neither machine: the launch stops with what to do",
      [{ at: "gone.png", type: "image" }],
      { throws: /gone\.png.*Send again/ },
    ],
    [
      "a file that isn't an image, not here: the launch stops with what to do",
      [{ at: "notes.pdf", type: "file" }],
      { throws: /notes\.pdf.*attach it again from this computer/ },
    ],
    [
      "two images with one name from two folders: two copies, each with its own bytes",
      [
        { at: "one/screen.png", type: "image", there: { bytes: "first" } },
        { at: "two/screen.png", type: "image", there: { bytes: "second" } },
      ],
      {
        copies: [
          { at: "one/screen.png", bytes: "first", uploadName: "screen.png" },
          { at: "two/screen.png", bytes: "second", uploadName: "screen.png" },
        ],
      },
    ],
    [
      "a HEIC the other machine sends as JPEG, with a name Windows can't hold: goes up as a JPEG",
      [{ at: "a:b.heic", type: "image", there: { bytes: "jpeg bytes", mime: "image/jpeg" } }],
      { copies: [{ at: "a:b.heic", bytes: "jpeg bytes", uploadName: "a:b.jpg" }] },
    ],
  ])("%s", async (_label, files, expected) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-launch-files-"));
    roots.push(root);
    const abs = (at: string) => path.join(root, at);
    for (const file of files) {
      if (file.here == null) continue;
      fs.mkdirSync(path.dirname(abs(file.at)), { recursive: true });
      fs.writeFileSync(abs(file.at), file.here);
    }
    const dir = path.join(root, "copies");
    const run = copyLaunchFilesFromSource({
      attachments: files.map((file) => ({ type: file.type, path: abs(file.at) }) as AgentChatFileRef),
      dir,
      readSourceImage: async (filePath) => {
        const there = files.find((file) => abs(file.at) === filePath)?.there;
        if (!there) throw new Error("the file was not found");
        return `data:${there.mime ?? "image/png"};base64,${Buffer.from(there.bytes).toString("base64")}`;
      },
    });

    if ("throws" in expected) {
      await expect(run).rejects.toThrow(expected.throws);
      return;
    }
    const copies = await run;
    expect(Object.keys(copies).sort()).toEqual(expected.copies.map((copy) => abs(copy.at)).sort());
    for (const copy of expected.copies) {
      const local = copies[abs(copy.at)]!;
      // The copy is in the launch's folder, named so Windows can write it, and holds the other machine's bytes.
      expect(path.dirname(local)).toBe(dir);
      expect(path.basename(local)).not.toMatch(/[<>:"|?*]/);
      expect(fs.readFileSync(local, "utf8")).toBe(copy.bytes);
      expect(launchFileName(abs(copy.at), local)).toBe(copy.uploadName);
    }
    // Files the copy left alone stay what they were.
    for (const file of files) {
      if (file.here != null) expect(fs.readFileSync(abs(file.at), "utf8")).toBe(file.here);
    }
  });
});
