import fs from "node:fs";
import path from "node:path";
import type {
  ReviewResolvedCompareTarget,
  ReviewRunArtifact,
  ReviewRunConfig,
  ReviewTarget,
} from "../../../shared/types";
import type { createLaneService } from "../lanes/laneService";
import { runGit, runGitOrThrow } from "../git/git";

type ReviewMaterializedFile = {
  filePath: string;
  excerpt: string;
  lineNumbers: number[];
};

export type ReviewMaterializedTarget = {
  targetLabel: string;
  compareTarget: ReviewResolvedCompareTarget | null;
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
    const buffer = fs.readFileSync(absPath);
    if (buffer.includes(0)) {
      return { exists: true, text: "", isBinary: true };
    }
    const text = buffer.toString("utf8");
    return { exists: true, text: truncateText(text, maxBytes), isBinary: false };
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
  const byPath = new Map<string, { lines: string[]; lineNumbers: Set<number> }>();
  for (const fallbackPath of fallbackPaths) {
    if (!byPath.has(fallbackPath)) {
      byPath.set(fallbackPath, { lines: [], lineNumbers: new Set<number>() });
    }
  }

  const lines = patchText.split(/\r?\n/);
  let currentPath: string | null = null;
  let currentNewLine: number | null = null;

  const ensureEntry = (filePath: string) => {
    const existing = byPath.get(filePath);
    if (existing) return existing;
    const created = { lines: [] as string[], lineNumbers: new Set<number>() };
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

    if (line.startsWith("+") && !line.startsWith("+++")) {
      entry.lineNumbers.add(currentNewLine);
      currentNewLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }
    if (!line.startsWith("\\")) {
      entry.lineNumbers.add(currentNewLine);
      currentNewLine += 1;
    }
  }

  return Array.from(byPath.entries()).map(([filePath, entry]) => ({
    filePath,
    excerpt: truncateText(entry.lines.join("\n").trim(), 4_000),
    lineNumbers: Array.from(entry.lineNumbers).sort((a, b) => a - b),
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

function buildDiffArtifact(contentText: string): Omit<ReviewRunArtifact, "id" | "runId" | "createdAt"> {
  return {
    artifactType: "diff_bundle",
    title: "Diff bundle",
    mimeType: "text/plain",
    contentText,
    metadata: null,
  };
}

export function createReviewTargetMaterializer({
  laneService,
}: {
  laneService: Pick<ReturnType<typeof createLaneService>, "getLaneBaseAndBranch" | "list">;
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
    const stagedPatch = await runGit(["diff", "--cached", "--no-color", "--find-renames"], {
      cwd: lane.worktreePath,
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    const unstagedPatch = await runGit(["diff", "--no-color", "--find-renames"], {
      cwd: lane.worktreePath,
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    const statusResult = await runGit(["status", "--porcelain=v1"], {
      cwd: lane.worktreePath,
      timeoutMs: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });

    const untrackedArtifacts: Array<Omit<ReviewRunArtifact, "id" | "runId" | "createdAt">> = [];
    const untrackedSections: string[] = [];
    const fallbackPaths = new Set<string>();
    const statusLines = statusResult.stdout
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
          untrackedSections.push(`### Untracked file: ${normalizedPath}\n${contentText}`);
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
    if (stagedPatch.stdout.trim()) {
      sections.push(`## Staged changes\n${stagedPatch.stdout.trim()}`);
    }
    if (unstagedPatch.stdout.trim()) {
      sections.push(`## Unstaged changes\n${unstagedPatch.stdout.trim()}`);
    }
    if (untrackedSections.length > 0) {
      sections.push(`## Untracked files\n${untrackedSections.join("\n\n")}`);
    }
    const fullPatchText = sections.join("\n\n").trim();
    const changedFiles = parseDiffFiles(fullPatchText, Array.from(fallbackPaths));

    return {
      targetLabel: `${branchRef} working tree`,
      compareTarget: null,
      fullPatchText,
      changedFiles,
      artifacts: [buildDiffArtifact(fullPatchText), ...untrackedArtifacts],
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
      return materializeWorkingTree({ target: args.target });
    },
  };
}
