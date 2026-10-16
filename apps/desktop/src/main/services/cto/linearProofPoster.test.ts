import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseArtifactView } from "../../../shared/types";
import { createLinearProofPoster } from "./linearProofPoster";

vi.mock("node:fs", () => ({
  default: { statSync: () => ({ size: 12 }) },
}));

describe("Linear PR proof posting", () => {
  const artifact = {
    id: "proof-1",
    title: "Before and after",
    createdAt: "2026-09-30T12:00:00.000Z",
    storageKind: "file",
    uri: "ade-artifact://proof-1",
    mimeType: "image/png",
    availability: "available",
  } as ComputerUseArtifactView;

  let posted: string[];
  let setJson: ReturnType<typeof vi.fn>;
  let uploadAttachment: ReturnType<typeof vi.fn>;
  let createComment: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    posted = [];
    setJson = vi.fn((_key: string, value: unknown) => { posted = value as string[]; });
    uploadAttachment = vi.fn(async (_input: { issueId: string; filePath: string; title?: string }) => ({ url: "https://linear.example/attachment" }));
    createComment = vi.fn(async (_issueId: string, _body: string): Promise<void> => undefined);
  });

  function makePoster(resolveFilePath: (item: ComputerUseArtifactView) => string | null = () => "/artifacts/proof.png") {
    return createLinearProofPoster({
      logger: { warn: vi.fn() } as never,
      kv: { getJson: <T>() => posted as T | null, setJson },
      listLaneProof: () => [artifact],
      resolveFilePath,
      uploadAttachment: uploadAttachment as unknown as (input: { issueId: string; filePath: string; title?: string }) => Promise<{ url: string; id?: string }>,
      createComment: createComment as unknown as (issueId: string, body: string) => Promise<unknown>,
    });
  }

  const args = { laneId: "lane-1", laneName: "Linear work", issueIds: ["issue-1"], prNumber: 42, githubUrl: "https://github.com/ade/pull/42" };

  it("retries uploaded proof after Linear rejects the comment and records it only after success", async () => {
    createComment.mockRejectedValueOnce(new Error("temporary failure"));
    const post = makePoster();

    await post(args);
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(setJson).not.toHaveBeenCalled();

    await post(args);
    expect(uploadAttachment).toHaveBeenCalledTimes(2);
    expect(createComment).toHaveBeenCalledTimes(2);
    expect(setJson).toHaveBeenCalledWith("linear.proofPosted.v1:issue-1", ["proof-1"]);
    expect(posted).toEqual(["proof-1"]);
  });
});
