import fs from "node:fs";
import type { Logger } from "../logging/logger";
import type { ComputerUseArtifactView } from "../../../shared/types";

/**
 * When a lane opens a PR for Linear issues, attach the lane's proof (the
 * screenshots and recordings in its proof drawer) to each issue, so the person
 * in Linear sees what changed without opening ADE. Each artifact is posted to
 * an issue once.
 */
const POSTED_KEY_PREFIX = "linear.proofPosted.v1:";
const MAX_PER_PR = 4;
const MAX_BYTES = 50 * 1024 * 1024;

function isPostable(artifact: ComputerUseArtifactView): boolean {
  if (artifact.storageKind !== "file") return false;
  if (artifact.availability && artifact.availability !== "available") return false;
  const mime = artifact.mimeType ?? "";
  return mime.startsWith("image/") || mime === "video/mp4";
}

function escapeMarkdownLabel(text: string): string {
  return text.replace(/[\\[\]()*_`<>]/g, (char) => `\\${char}`).replace(/\s+/g, " ").trim();
}

export function createLinearProofPoster(deps: {
  logger: Logger;
  kv: { getJson<T>(key: string): T | null; setJson(key: string, value: unknown): void };
  listLaneProof: (laneId: string) => ComputerUseArtifactView[];
  /** The artifact's file, confined to the project's artifacts directory (null when it is not a local file). */
  resolveFilePath: (artifact: ComputerUseArtifactView) => string | null;
  uploadAttachment: (args: { issueId: string; filePath: string; title?: string }) => Promise<{ url: string; id?: string }>;
  createComment: (issueId: string, body: string) => Promise<unknown>;
}) {
  return async (args: { laneId: string; laneName: string; issueIds: string[]; prNumber: number; githubUrl: string }): Promise<void> => {
    const proof = deps.listLaneProof(args.laneId)
      .filter(isPostable)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (proof.length === 0) return;
    for (const issueId of args.issueIds) {
      const key = `${POSTED_KEY_PREFIX}${issueId}`;
      const posted = new Set(deps.kv.getJson<string[]>(key) ?? []);
      const fresh = proof.filter((artifact) => !posted.has(artifact.id)).slice(0, MAX_PER_PR);
      if (fresh.length === 0) continue;
      const uploaded: Array<{ id: string; title: string; url: string; video: boolean }> = [];
      for (const artifact of fresh) {
        try {
          const filePath = deps.resolveFilePath(artifact);
          if (!filePath) continue;
          if (fs.statSync(filePath).size > MAX_BYTES) continue;
          const result = await deps.uploadAttachment({ issueId, filePath, title: artifact.title });
          uploaded.push({ id: artifact.id, title: artifact.title, url: result.url, video: artifact.mimeType === "video/mp4" });
        } catch (error) {
          deps.logger.warn("linear_proof.upload_failed", {
            issueId,
            artifactId: artifact.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (uploaded.length === 0) continue;
      const lines = [
        `**Proof from ADE** · [PR #${args.prNumber}](${args.githubUrl}) · lane ${escapeMarkdownLabel(args.laneName)}`,
        "",
        ...uploaded.map((item) => {
          const label = escapeMarkdownLabel(item.title);
          return item.video ? `- 🎬 [${label}](${item.url})` : `- ![${label}](${item.url})`;
        }),
      ];
      try {
        await deps.createComment(issueId, lines.join("\n"));
      } catch (error) {
        // Not marked posted, so the next PR event tries again.
        deps.logger.warn("linear_proof.comment_failed", { issueId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      for (const item of uploaded) posted.add(item.id);
      deps.kv.setJson(key, [...posted].slice(-200));
    }
  };
}
