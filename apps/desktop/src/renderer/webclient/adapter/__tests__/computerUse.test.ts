import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncArtifactRange } from "../../../../shared/types/sync";
import { AdeSyncError, type AdeSyncClient } from "../../sync";
import type { AdapterInfra } from "../types";
import { createComputerUseNamespace } from "../computerUse";

/**
 * A host with one stored proof: it refuses the whole-file read over its cap
 * with the error `syncFileRequests.ts` sends, and serves `readArtifactRange`
 * in slices of `sliceBytes`, the way the brain does.
 */
function hostWith(file: Uint8Array, sliceBytes: number) {
  const requestFile = vi.fn(async (action: string, args: { uri: string; offset?: number }) => {
    if (action === "readArtifact") {
      throw new AdeSyncError(`Artifact is too large to sync (${file.length} bytes; max 8 bytes).`, "file_request_failed", null);
    }
    const start = args.offset ?? 0;
    const end = Math.min(file.length, start + sliceBytes);
    const range: SyncArtifactRange = {
      path: args.uri,
      totalSize: file.length,
      rangeStart: start,
      rangeEnd: end,
      encoding: "base64",
      content: Buffer.from(file.subarray(start, end)).toString("base64"),
      eof: end >= file.length,
    };
    return range;
  });
  const infra = {
    client: { getStatus: () => ({ selectedEnvId: "env-1" }), requestFile } as unknown as AdeSyncClient,
    state: { getProjectId: () => "project-1" },
  } as unknown as AdapterInfra;
  return { infra, requestFile };
}

describe("computerUse.readArtifactPreview on the web", () => {
  afterEach(() => vi.restoreAllMocks());

  it("plays a proof over the host's whole-file cap from its slices, and pulls it once", async () => {
    const file = Uint8Array.from({ length: 25 }, (_, index) => index * 7);
    const { infra, requestFile } = hostWith(file, 10);
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return `blob:test/${blobs.length}`;
    });
    const computerUse = createComputerUseNamespace(infra);

    const url = await computerUse.readArtifactPreview!({ uri: ".ade/artifacts/computer-use/big-recording.mov" });

    expect(url).toBe("blob:test/1");
    expect(blobs[0]!.type).toBe("video/mp4");
    expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(file);
    expect(requestFile.mock.calls.filter(([action]) => action === "readArtifactRange").map(([, args]) => args.offset))
      .toEqual([0, 10, 20]);

    requestFile.mockClear();
    await expect(computerUse.readArtifactPreview!({ uri: ".ade/artifacts/computer-use/big-recording.mov" })).resolves.toBe(url);
    expect(requestFile).not.toHaveBeenCalled();
  });
});
