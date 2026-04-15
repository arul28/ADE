import type {
  PrAiSummary,
  PrComment,
  PrDetail,
  PrFile,
  PrReviewThread,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createPrService } from "./prService";
import { extractFirstJsonObject } from "../ai/utils";
import { asString, nowIso } from "../shared/utils";

type PrSummaryServiceDeps = {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  prService: ReturnType<typeof createPrService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>;
};

type CachedSummaryRow = {
  pr_id: string;
  head_sha: string;
  summary_json: string;
  generated_at: string;
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function summarizeBotReviews(comments: PrComment[]): string {
  const bots = comments.filter((c) => {
    const login = c.author?.toLowerCase() ?? "";
    return login.includes("bot") || login.includes("greptile") || login.includes("seer") || login.includes("coderabbit");
  });
  if (bots.length === 0) return "(no bot reviews)";
  return bots
    .slice(0, 5)
    .map((c) => `- @${c.author}: ${(c.body ?? "").slice(0, 280)}`)
    .join("\n");
}

export function buildPrSummaryPrompt(args: {
  title: string;
  body: string | null;
  changedFiles: PrFile[];
  issueComments: PrComment[];
  unresolvedThreadCount: number;
}): string {
  const fileList = args.changedFiles
    .slice(0, 30)
    .map((f) => `- ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`)
    .join("\n");
  const hidden = args.changedFiles.length > 30 ? `\n(+${args.changedFiles.length - 30} more files)` : "";
  return [
    "You are a senior reviewer preparing a pull-request briefing card.",
    'Return ONLY a JSON object with this exact shape:',
    '{"summary": string, "riskAreas": string[], "reviewerHotspots": string[], "unresolvedConcerns": string[]}',
    "",
    "- summary: 2-3 sentences, plain English, what this PR does and why it matters.",
    "- riskAreas: short phrases naming the riskiest subsystems or files to inspect.",
    "- reviewerHotspots: 1-6 short bullet points reviewers should focus on.",
    "- unresolvedConcerns: 0-6 items explicitly derived from bot/human review comments that are still open. Skip if none.",
    "",
    `PR title: ${args.title}`,
    "",
    "PR description:",
    (args.body ?? "").slice(0, 4000) || "(empty)",
    "",
    "Changed files:",
    fileList || "(none)",
    hidden,
    "",
    `Unresolved review threads: ${args.unresolvedThreadCount}`,
    "",
    "Bot review summaries:",
    summarizeBotReviews(args.issueComments),
    "",
    "Return the JSON object only. No code fences, no prose.",
  ].join("\n");
}

export function parsePrSummaryJson(raw: string | null | undefined): Pick<
  PrAiSummary,
  "summary" | "riskAreas" | "reviewerHotspots" | "unresolvedConcerns"
> | null {
  if (!raw) return null;
  const json = extractFirstJsonObject(raw);
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    return {
      summary: typeof obj.summary === "string" ? obj.summary.trim() : "",
      riskAreas: toStringArray(obj.riskAreas),
      reviewerHotspots: toStringArray(obj.reviewerHotspots),
      unresolvedConcerns: toStringArray(obj.unresolvedConcerns),
    };
  } catch {
    return null;
  }
}

async function fetchPrInputs(deps: PrSummaryServiceDeps, prId: string): Promise<{
  title: string;
  body: string | null;
  files: PrFile[];
  issueComments: PrComment[];
  unresolvedThreadCount: number;
  headSha: string | null;
  detail: PrDetail | null;
}> {
  const summaries = deps.prService.listAll();
  const summary = summaries.find((s) => s.id === prId);
  const [detail, files, comments, threads] = await Promise.all([
    deps.prService.getDetail(prId).catch((): PrDetail | null => null),
    deps.prService.getFiles(prId).catch((): PrFile[] => []),
    deps.prService.getComments(prId).catch((): PrComment[] => []),
    deps.prService.getReviewThreads(prId).catch((): PrReviewThread[] => []),
  ]);
  const unresolved = threads.filter((t) => !t.isResolved).length;
  // headSha lookup: prefer pull_requests.head_sha column; fall back to null if unavailable.
  const row = deps.db.get<{ head_sha: string | null }>(
    "select head_sha from pull_requests where id = ? limit 1",
    [prId],
  );
  const headSha = asString(row?.head_sha) || null;
  return {
    title: summary?.title ?? "(untitled)",
    body: detail?.body ?? null,
    files,
    issueComments: comments,
    unresolvedThreadCount: unresolved,
    headSha,
    detail,
  };
}

export function createPrSummaryService(deps: PrSummaryServiceDeps) {
  const readCache = (prId: string, headSha: string): PrAiSummary | null => {
    const row = deps.db.get<CachedSummaryRow>(
      "select pr_id, head_sha, summary_json, generated_at from pull_request_ai_summaries where pr_id = ? and head_sha = ? limit 1",
      [prId, headSha],
    );
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.summary_json) as Partial<PrAiSummary>;
      return {
        prId: row.pr_id,
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        riskAreas: toStringArray(parsed.riskAreas),
        reviewerHotspots: toStringArray(parsed.reviewerHotspots),
        unresolvedConcerns: toStringArray(parsed.unresolvedConcerns),
        generatedAt: row.generated_at,
        headSha: row.head_sha,
      };
    } catch (err) {
      deps.logger.warn("prs.ai_summary_cache_parse_failed", {
        prId,
        headSha,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  const writeCache = (summary: PrAiSummary): void => {
    deps.db.run(
      `
        insert or replace into pull_request_ai_summaries(pr_id, head_sha, summary_json, generated_at)
        values (?, ?, ?, ?)
      `,
      [
        summary.prId,
        summary.headSha,
        JSON.stringify({
          summary: summary.summary,
          riskAreas: summary.riskAreas,
          reviewerHotspots: summary.reviewerHotspots,
          unresolvedConcerns: summary.unresolvedConcerns,
        }),
        summary.generatedAt,
      ],
    );
  };

  const generate = async (prId: string, options: { force?: boolean } = {}): Promise<PrAiSummary> => {
    const inputs = await fetchPrInputs(deps, prId);
    const headSha = inputs.headSha ?? "unknown";
    if (!options.force && inputs.headSha) {
      const cached = readCache(prId, inputs.headSha);
      if (cached) return cached;
    }

    const prompt = buildPrSummaryPrompt({
      title: inputs.title,
      body: inputs.body,
      changedFiles: inputs.files,
      issueComments: inputs.issueComments,
      unresolvedThreadCount: inputs.unresolvedThreadCount,
    });

    if (!deps.aiIntegrationService) {
      const fallback: PrAiSummary = {
        prId,
        summary: `This PR modifies ${inputs.files.length} file(s).`,
        riskAreas: [],
        reviewerHotspots: [],
        unresolvedConcerns:
          inputs.unresolvedThreadCount > 0
            ? [`${inputs.unresolvedThreadCount} unresolved review threads`]
            : [],
        generatedAt: nowIso(),
        headSha,
      };
      if (inputs.headSha) writeCache(fallback);
      return fallback;
    }

    try {
      const result = await deps.aiIntegrationService.draftPrDescription({
        laneId: "", // aiIntegrationService accepts empty laneId for one-shot tasks; uses projectRoot cwd.
        cwd: deps.projectRoot,
        prompt,
      });
      const parsed = parsePrSummaryJson(result.text);
      const summary: PrAiSummary = {
        prId,
        summary: parsed?.summary ?? "AI summary unavailable.",
        riskAreas: parsed?.riskAreas ?? [],
        reviewerHotspots: parsed?.reviewerHotspots ?? [],
        unresolvedConcerns: parsed?.unresolvedConcerns ?? [],
        generatedAt: nowIso(),
        headSha,
      };
      if (inputs.headSha) writeCache(summary);
      return summary;
    } catch (err) {
      deps.logger.warn("prs.ai_summary_generate_failed", {
        prId,
        error: err instanceof Error ? err.message : String(err),
      });
      const fallback: PrAiSummary = {
        prId,
        summary: "AI summary failed. Try regenerating.",
        riskAreas: [],
        reviewerHotspots: [],
        unresolvedConcerns: [],
        generatedAt: nowIso(),
        headSha,
      };
      return fallback;
    }
  };

  return {
    getSummary: async (prId: string): Promise<PrAiSummary | null> => {
      const row = deps.db.get<{ head_sha: string | null }>(
        "select head_sha from pull_requests where id = ? limit 1",
        [prId],
      );
      const headSha = asString(row?.head_sha) || null;
      if (!headSha) return null;
      return readCache(prId, headSha);
    },
    regenerateSummary: async (prId: string): Promise<PrAiSummary> => generate(prId, { force: true }),
    ensureSummary: async (prId: string): Promise<PrAiSummary> => generate(prId, { force: false }),
  };
}
