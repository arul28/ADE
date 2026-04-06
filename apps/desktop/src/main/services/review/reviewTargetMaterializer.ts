import fs from "node:fs";
import path from "node:path";
import type {
  PrFile,
  PrReviewSnapshot,
  ReviewPublicationDestination,
  ReviewResolvedCompareTarget,
  ReviewRunArtifact,
  ReviewRunConfig,
  ReviewTarget,
} from "../../../shared/types";
import type { createLaneService } from "../lanes/laneService";
import type { createPrService } from "../prs/prService";
import { runGit, runGitOrThrow } from "../git/git";

type ReviewMaterializedFile = {
  filePath: string;
  excerpt: string;
  lineNumbers: number[];
  diffPositionsByLine: Record<number, number>;
};

export type ReviewMaterializedTarget = {
  targetLabel: string;
  compareTarget: ReviewResolvedCompareTarget | null;
  publicationTarget: ReviewPublicationDestination | null;
  fullPatchText: string;
  changedFiles: ReviewMaterializedFile[];
  artifacts: Array<Omit<ReviewRunArtifact, "id" | "runId" | "createdAt">>;
};

type LaneInfo = ReturnType<ReturnType<typeof createLaneService>["getLaneBaseAndBranch"]>;

function normalizeBranchRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...(truncated)...\n`;
}

function readTextFileSafe(absPath: string, maxBytes: number): { exists: boolean; text: string; isBinary: boolean } {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { exists: false, text: "", isBinary: false };
    const fd = fs.openSync(absPath, "r");
    try {
      const bytesToRead = Math.max(1, Math.min(stat.size, maxBytes));
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
      const slice = buffer.subarray(0, bytesRead);
      if (slice.includes(0)) {
        return { exists: true, text: "", isBinary: true };
      }
      const text = slice.toString("utf8");
      return { exists: true, text: truncateText(text, maxBytes), isBinary: false };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { exists: false, text: "", isBinary: false };
  }
}

function parseNameStatus(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t").filter(Boolean);
      if (parts.length >= 3 && /^R\d+$/i.test(parts[0] ?? "")) {
        return parts[2] ?? "";
      }
      return parts.at(-1) ?? "";
    })
    .filter(Boolean);
}

function parseDiffFiles(patchText: string, fallbackPaths: string[]): ReviewMaterializedFile[] {
  const byPath = new Map<string, { lines: string[]; lineNumbers: Set<number>; diffPositionsByLine: Map<number, number> }>();
  for (const fallbackPath of fallbackPaths) {
    if (!byPath.has(fallbackPath)) {
      byPath.set(fallbackPath, {
        lines: [],
        lineNumbers: new Set<number>(),
        diffPositionsByLine: new Map<number, number>(),
      });
    }
  }

  const lines = patchText.split(/\r?\n/);
  let currentPath: string | null = null;
  let currentNewLine: number | null = null;
  let currentDiffPosition = 0;

  const ensureEntry = (filePath: string) => {
    const existing = byPath.get(filePath);
    if (existing) return existing;
    const created = {
      lines: [] as string[],
      lineNumbers: new Set<number>(),
      diffPositionsByLine: new Map<number, number>(),
    };
    byPath.set(filePath, created);
    return created;
  };

  for (const line of lines) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      const oldPath = diffMatch[1] ?? "";
      const newPath = diffMatch[2] ?? "";
      currentPath = newPath === "/dev/null" ? oldPath : newPath;
      currentNewLine = null;
      currentDiffPosition = 0;
      continue;
    }
    if (!currentPath) continue;
    const entry = ensureEntry(currentPath);
    entry.lines.push(line);

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = Number(hunkMatch[1] ?? "0");
      continue;
    }
    if (currentNewLine == null) continue;
    if (line.length === 0) continue;
    if (line.startsWith("\\")) continue;

    currentDiffPosition += 1;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      entry.lineNumbers.add(currentNewLine);
      entry.diffPositionsByLine.set(currentNewLine, currentDiffPosition);
      currentNewLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }
    entry.lineNumbers.add(currentNewLine);
    entry.diffPositionsByLine.set(currentNewLine, currentDiffPosition);
    currentNewLine += 1;
  }

  return Array.from(byPath.entries()).map(([filePath, entry]) => ({
    filePath,
    excerpt: truncateText(entry.lines.join("\n").trim(), 4_000),
    lineNumbers: Array.from(entry.lineNumbers).sort((a, b) => a - b),
    diffPositionsByLine: Object.fromEntries(entry.diffPositionsByLine.entries()),
  }));
}

async function resolveDefaultCompareTarget(lane: LaneInfo): Promise<ReviewResolvedCompareTarget> {
  const branchRef = normalizeBranchRef(lane.branchRef);
  const baseRef = normalizeBranchRef(lane.baseRef);
  if (lane.laneType === "primary") {
    const upstreamRef = `${branchRef}@{upstream}`;
    const upstreamRes = await runGit(["rev-parse", "--verify", upstreamRef], {
      cwd: lane.worktreePath,
      timeoutMs: 5_000,
    });
    if (upstreamRes.exitCode === 0 && upstreamRes.stdout.trim()) {
      return {
        kind: "default_branch",
        label: upstreamRef,
        ref: upstreamRef,
        laneId: null,
        branchRef: upstreamRef,
      };
    }
    const originRef = `origin/${branchRef}`;
    const originRes = await runGit(["rev-parse", "--verify", originRef], {
      cwd: lane.worktreePath,
      timeoutMs: 5_000,
    });
    if (originRes.exitCode === 0 && originRes.stdout.trim()) {
      return {
        kind: "default_branch",
        label: originRef,
        ref: originRef,
        laneId: null,
        branchRef: originRef,
      };
    }
  }
  return {
    kind: "default_branch",
    label: baseRef,
    ref: baseRef,
    laneId: null,
    branchRef: baseRef,
  };
}

function buildDiffArtifact(
  contentText: string,
  metadata: Record<string, unknown> | null = null,
): Omit<ReviewRunArtifact, "id" | "runId" | "createdAt"> {
  return {
    artifactType: "diff_bundle",
    title: "Diff bundle",
    mimeType: "text/plain",
    contentText,
    metadata,
  };
}

function buildUntrackedFileDiff(filePath: string, contentText: string): string {
  const normalized = contentText.replace(/\r\n/g, "\n");
  const hasTrailingNewline = normalized.endsWith("\n");
  const rawLines = normalized.length > 0 ? normalized.split("\n") : [];
  const lines = hasTrailingNewline ? rawLines.slice(0, -1) : rawLines;
  const hunkSize = lines.length;
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${hunkSize} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function buildPrFileDiff(file: PrFile): string {
  const diffPath = file.previousFilename ?? file.filename;
  const oldPath = file.status === "added" ? "/dev/null" : `a/${file.previousFilename ?? file.filename}`;
  const newPath = file.status === "removed" ? "/dev/null" : `b/${file.filename}`;
  const patchBody = file.patch?.trim() ?? "";
  return [
    `diff --git a/${diffPath} b/${file.filename}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    patchBody,
  ].join("\n");
}

function buildPrFullPatch(files: PrFile[]): string {
  return files.map(buildPrFileDiff).join("\n\n").trim();
}

function buildPrPublicationTarget(summary: Pick<PrReviewSnapshot, "id" | "repoOwner" | "repoName" | "githubPrNumber" | "githubUrl">): ReviewPublicationDestination {
  return {
    kind: "github_pr_review",
    prId: summary.id,
    repoOwner: summary.repoOwner,
    repoName: summary.repoName,
    prNumber: summary.githubPrNumber,
    githubUrl: summary.githubUrl,
  };
}

export function createReviewTargetMaterializer({
  laneService,
  prService,
}: {
  laneService: Pick<ReturnType<typeof createLaneService>, "getLaneBaseAndBranch" | "list">;
  prService?: Pick<ReturnType<typeof createPrService>, "getReviewSnapshot">;
}) {
  async function materializeLaneDiff(args: {
    target: Extract<ReviewTarget, { mode: "lane_diff" }>;
    config: ReviewRunConfig;
  }): Promise<ReviewMaterializedTarget> {
    const lane = laneService.getLaneBaseAndBranch(args.target.laneId);
    const sourceRef = normalizeBranchRef(lane.branchRef);
    let compareTarget = await resolveDefaultCompareTarget(lane);
    if (args.config.compareAgainst.kind === "lane") {
      const compareLane = laneService.getLaneBaseAndBranch(args.config.compareAgainst.laneId);
      compareTarget = {
        kind: "lane",
        label: normalizeBranchRef(compareLane.branchRef),
        ref: normalizeBranchRef(compareLane.branchRef),
        laneId: args.config.compareAgainst.laneId,
        branchRef: normalizeBranchRef(compareLane.branchRef),
      };
    }

    const mergeBase = await runGitOrThrow(["merge-base", compareTarget.ref ?? "HEAD", sourceRef], {
      cwd: lane.worktreePath,
      timeoutMs: 10_000,
    }).then((stdout) => stdout.trim());
    const patchText = await runGitOrThrow(["diff", "--no-color", "--find-renames", `${mergeBase}..${sourceRef}`], {
      cwd: lane.worktreePath,
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    const nameStatus = await runGitOrThrow(["diff", "--name-status", "--find-renames", `${mergeBase}..${sourceRef}`], {
      cwd: lane.worktreePath,
      timeoutMs: 15_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    const changedFiles = parseDiffFiles(patchText, parseNameStatus(nameStatus));

    return {
      targetLabel: `${sourceRef} vs ${compareTarget.label}`,
      compareTarget,
      publicationTarget: null,
      fullPatchText: patchText,
      changedFiles,
      artifacts: [buildDiffArtifact(patchText)],
    };
  }

  async function materializeCommitRange(args: {
    target: Extract<ReviewTarget, { mode: "commit_range" }>;
  }): Promise<ReviewMaterializedTarget> {
    const lane = laneService.getLaneBaseAndBranch(args.target.laneId);
    const range = `${args.target.baseCommit}..${args.target.headCommit}`;
    const patchText = await runGitOrThrow(["diff", "--no-color", "--find-renames", range], {
      cwd: lane.worktreePath,
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    const nameStatus = await runGitOrThrow(["diff", "--name-status", "--find-renames", range], {
      cwd: lane.worktreePath,
      timeoutMs: 15_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    const changedFiles = parseDiffFiles(patchText, parseNameStatus(nameStatus));

    return {
      targetLabel: `${normalizeBranchRef(lane.branchRef)} ${args.target.baseCommit.slice(0, 7)}..${args.target.headCommit.slice(0, 7)}`,
      compareTarget: null,
      publicationTarget: null,
      fullPatchText: patchText,
      changedFiles,
      artifacts: [buildDiffArtifact(patchText)],
    };
  }

  async function materializeWorkingTree(args: {
    target: Extract<ReviewTarget, { mode: "working_tree" }>;
  }): Promise<ReviewMaterializedTarget> {
    const lane = laneService.getLaneBaseAndBranch(args.target.laneId);
    const branchRef = normalizeBranchRef(lane.branchRef);
    const stagedPatch = await runGitOrThrow(["diff", "--cached", "--no-color", "--find-renames"], {
      cwd: lane.worktreePath,
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    const unstagedPatch = await runGitOrThrow(["diff", "--no-color", "--find-renames"], {
      cwd: lane.worktreePath,
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    const statusResult = await runGitOrThrow(["status", "--porcelain=v1"], {
      cwd: lane.worktreePath,
      timeoutMs: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });

    const untrackedArtifacts: Array<Omit<ReviewRunArtifact, "id" | "runId" | "createdAt">> = [];
    const untrackedPatchSections: string[] = [];
    const fallbackPaths = new Set<string>();
    const statusLines = statusResult
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    for (const line of statusLines) {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      if (!rawPath) continue;
      const normalizedPath = rawPath.includes("->")
        ? rawPath.split("->").at(-1)?.trim() ?? rawPath
        : rawPath;
      fallbackPaths.add(normalizedPath);
      if (code === "??") {
        const absPath = path.join(lane.worktreePath, normalizedPath);
        const file = readTextFileSafe(absPath, 128_000);
        if (file.exists && !file.isBinary) {
          const contentText = file.text;
          untrackedPatchSections.push(buildUntrackedFileDiff(normalizedPath, contentText));
          untrackedArtifacts.push({
            artifactType: "untracked_snapshot",
            title: `Untracked: ${normalizedPath}`,
            mimeType: "text/plain",
            contentText,
            metadata: { filePath: normalizedPath },
          });
        }
      }
    }

    const sections: string[] = [];
    if (stagedPatch.trim()) {
      sections.push(`## Staged changes\n${stagedPatch.trim()}`);
    }
    if (unstagedPatch.trim()) {
      sections.push(`## Unstaged changes\n${unstagedPatch.trim()}`);
    }
    if (untrackedPatchSections.length > 0) {
      sections.push(`## Untracked files\n${untrackedPatchSections.join("\n\n")}`);
    }
    const fullPatchText = sections.join("\n\n").trim();
    const changedFiles = parseDiffFiles(fullPatchText, Array.from(fallbackPaths));

    return {
      targetLabel: `${branchRef} working tree`,
      compareTarget: null,
      publicationTarget: null,
      fullPatchText,
      changedFiles,
      artifacts: [buildDiffArtifact(fullPatchText), ...untrackedArtifacts],
    };
  }

  async function materializePullRequest(args: {
    target: Extract<ReviewTarget, { mode: "pr" }>;
  }): Promise<ReviewMaterializedTarget> {
    if (!prService) {
      throw new Error("PR review target is not available in this workspace.");
    }

    const lane = laneService.getLaneBaseAndBranch(args.target.laneId);
    const snapshot = await prService.getReviewSnapshot(args.target.prId);
    const range = snapshot.baseSha && snapshot.headSha ? `${snapshot.baseSha}..${snapshot.headSha}` : null;

    let patchText = "";
    if (range) {
      try {
        patchText = await runGitOrThrow(["diff", "--no-color", "--find-renames", range], {
          cwd: lane.worktreePath,
          timeoutMs: 30_000,
          maxOutputBytes: 8 * 1024 * 1024,
        });
      } catch {
        patchText = "";
      }
    }
    if (!patchText.trim()) {
      patchText = buildPrFullPatch(snapshot.files);
    }

    const changedFiles = parseDiffFiles(
      patchText,
      snapshot.files.map((file) => file.filename),
    );
    const compareTarget: ReviewResolvedCompareTarget = {
      kind: "default_branch",
      label: snapshot.baseBranch,
      ref: snapshot.baseSha ?? snapshot.baseBranch,
      laneId: null,
      branchRef: snapshot.baseBranch,
    };

    return {
      targetLabel: `PR #${snapshot.githubPrNumber} ${snapshot.headBranch} -> ${snapshot.baseBranch}`,
      compareTarget,
      publicationTarget: buildPrPublicationTarget(snapshot),
      fullPatchText: patchText,
      changedFiles,
      artifacts: [
        buildDiffArtifact(patchText, {
          targetMode: "pr",
          prId: snapshot.id,
          githubPrNumber: snapshot.githubPrNumber,
          repoOwner: snapshot.repoOwner,
          repoName: snapshot.repoName,
          baseSha: snapshot.baseSha,
          headSha: snapshot.headSha,
        }),
      ],
    };
  }

  return {
    async materialize(args: { target: ReviewTarget; config: ReviewRunConfig }): Promise<ReviewMaterializedTarget> {
      if (args.target.mode === "lane_diff") {
        return materializeLaneDiff({
          target: args.target,
          config: args.config,
        });
      }
      if (args.target.mode === "commit_range") {
        return materializeCommitRange({ target: args.target });
      }
      if (args.target.mode === "pr") {
        return materializePullRequest({ target: args.target });
      }
      return materializeWorkingTree({ target: args.target });
    },
  };
}
