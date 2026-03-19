import type { ChangeDigest, KnowledgeSyncStatus } from "../../../shared/types";
import { runGit } from "../git/git";
import type { Logger } from "../logging/logger";

function formatDigestContent(digest: ChangeDigest): string {
  const lines: string[] = [
    `Human work digest ${digest.fromSha.slice(0, 8)} -> ${digest.toSha.slice(0, 8)}`,
    `${digest.commitCount} commit(s) changed.`,
    digest.diffstat,
  ];
  if (digest.commitSummaries.length > 0) {
    lines.push("Commits:");
    lines.push(...digest.commitSummaries.map((entry) => `- ${entry}`));
  }
  if (digest.fileClusters.length > 0) {
    lines.push("Clusters:");
    for (const cluster of digest.fileClusters) {
      lines.push(`- ${cluster.label}: ${cluster.summary}`);
    }
  }
  if (digest.changedFiles.length > 0) {
    lines.push("Changed files:");
    lines.push(...digest.changedFiles.slice(0, 40).map((entry) => `- ${entry}`));
  }
  return lines.join("\n");
}

function clusterFiles(files: string[]): ChangeDigest["fileClusters"] {
  const buckets = new Map<string, string[]>();
  for (const file of files) {
    const trimmed = file.trim();
    if (!trimmed) continue;
    const label = trimmed.includes("/") ? trimmed.split("/")[0]! : "root";
    const bucket = buckets.get(label) ?? [];
    bucket.push(trimmed);
    buckets.set(label, bucket);
  }
  return [...buckets.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([label, grouped]) => ({
      label,
      files: grouped,
      summary: `${grouped.length} file(s) touched under ${label}.`,
    }));
}

export function createHumanWorkDigestService(args: {
  projectId: string;
  projectRoot: string;
  logger?: Pick<Logger, "warn"> | null;
  memoryService?: unknown;
}) {
  // In-memory cursor -- no longer persisted to the memory store.
  let inMemoryCursorSha: string | null = null;

  let syncState: KnowledgeSyncStatus = {
    syncing: false,
    lastSeenHeadSha: null,
    currentHeadSha: null,
    diverged: false,
    lastDigestAt: null,
    lastDigestMemoryId: null,
    lastError: null,
  };

  const readLastSeenHeadSha = (): string | null => {
    return inMemoryCursorSha;
  };

  const readCurrentHeadSha = async (): Promise<string | null> => {
    const result = await runGit(["rev-parse", "HEAD"], { cwd: args.projectRoot, timeoutMs: 8_000 });
    if (result.exitCode !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  };

  const writeCursor = (headSha: string) => {
    inMemoryCursorSha = headSha;
  };

  const buildDigest = async (fromSha: string, toSha: string): Promise<ChangeDigest> => {
    const [countResult, logResult, diffStatResult, diffFilesResult] = await Promise.all([
      runGit(["rev-list", "--count", `${fromSha}..${toSha}`], { cwd: args.projectRoot, timeoutMs: 8_000 }),
      runGit(["log", "--oneline", "--max-count=20", `${fromSha}..${toSha}`], { cwd: args.projectRoot, timeoutMs: 8_000 }),
      runGit(["diff", "--stat", fromSha, toSha], { cwd: args.projectRoot, timeoutMs: 8_000 }),
      runGit(["diff", "--name-only", fromSha, toSha], { cwd: args.projectRoot, timeoutMs: 8_000 }),
    ]);

    const changedFiles = diffFilesResult.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    return {
      fromSha,
      toSha,
      commitCount: Math.max(0, Number.parseInt(countResult.stdout.trim(), 10) || 0),
      commitSummaries: logResult.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0),
      diffstat: diffStatResult.stdout.trim() || `${changedFiles.length} file(s) changed`,
      changedFiles,
      fileClusters: clusterFiles(changedFiles),
    };
  };

  const saveDigest = (digest: ChangeDigest) => {
    // No longer writes to the memory store -- only updates in-memory sync state.
    writeCursor(digest.toSha);
    syncState = {
      syncing: false,
      lastSeenHeadSha: digest.toSha,
      currentHeadSha: digest.toSha,
      diverged: false,
      lastDigestAt: new Date().toISOString(),
      lastDigestMemoryId: null,
      lastError: null,
    };
  };

  const syncKnowledge = async (): Promise<ChangeDigest | null> => {
    syncState = { ...syncState, syncing: true, lastError: null };
    try {
      const currentHeadSha = await readCurrentHeadSha();
      const lastSeenHeadSha = readLastSeenHeadSha();
      syncState = { ...syncState, currentHeadSha, lastSeenHeadSha, diverged: Boolean(currentHeadSha && lastSeenHeadSha && currentHeadSha !== lastSeenHeadSha) };
      if (!currentHeadSha) {
        syncState = { ...syncState, syncing: false };
        return null;
      }
      if (!lastSeenHeadSha || lastSeenHeadSha === currentHeadSha) {
        writeCursor(currentHeadSha);
        syncState = {
          ...syncState,
          syncing: false,
          currentHeadSha,
          lastSeenHeadSha: currentHeadSha,
          diverged: false,
          lastError: null,
        };
        return null;
      }

      const digest = await buildDigest(lastSeenHeadSha, currentHeadSha);
      saveDigest(digest);
      return digest;
    } catch (error) {
      syncState = {
        ...syncState,
        syncing: false,
        lastError: error instanceof Error ? error.message : String(error),
      };
      args.logger?.warn?.("memory.human_digest_sync_failed", {
        error: syncState.lastError,
      });
      throw error;
    }
  };

  const onHeadChanged = async (input?: { preHeadSha?: string | null; postHeadSha?: string | null }) => {
    const currentHeadSha = input?.postHeadSha?.trim() || await readCurrentHeadSha();
    const lastSeenHeadSha = readLastSeenHeadSha();
    syncState = {
      ...syncState,
      currentHeadSha: currentHeadSha ?? null,
      lastSeenHeadSha,
      diverged: Boolean(currentHeadSha && lastSeenHeadSha && currentHeadSha !== lastSeenHeadSha),
    };
    if (currentHeadSha && lastSeenHeadSha && currentHeadSha !== lastSeenHeadSha) {
      await syncKnowledge();
    }
  };

  const getKnowledgeSyncStatus = async (): Promise<KnowledgeSyncStatus> => {
    const currentHeadSha = await readCurrentHeadSha();
    const lastSeenHeadSha = readLastSeenHeadSha();
    syncState = {
      ...syncState,
      currentHeadSha,
      lastSeenHeadSha,
      diverged: Boolean(currentHeadSha && lastSeenHeadSha && currentHeadSha !== lastSeenHeadSha),
    };
    return syncState;
  };

  /** Return recent commit summaries directly from git (for briefing injection). */
  const getRecentCommitSummaries = async (count = 10): Promise<string[]> => {
    const result = await runGit(["log", "--oneline", `--max-count=${count}`], { cwd: args.projectRoot, timeoutMs: 8_000 });
    if (result.exitCode !== 0) return [];
    return result.stdout.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l.length > 0);
  };

  return {
    syncKnowledge,
    onHeadChanged,
    getKnowledgeSyncStatus,
    getRecentCommitSummaries,
  };
}

export type HumanWorkDigestService = ReturnType<typeof createHumanWorkDigestService>;
