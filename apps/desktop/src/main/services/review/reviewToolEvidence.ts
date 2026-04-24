import type {
  ReviewEvidence,
  ReviewFinding,
  ReviewToolSignalKind,
} from "../../../shared/types";
import type { ReviewContextValidationPayload } from "./reviewContextBuilder";

type ValidationSignalSource = ReviewContextValidationPayload["signals"][number];

const STATUS_BY_KIND: Record<ReviewToolSignalKind, "pass" | "fail" | "warn" | "info"> = {
  typecheck: "fail",
  test: "fail",
  lint: "fail",
  build: "fail",
  ci_check: "fail",
  validation: "warn",
};

function classifyCheck(name: string): ReviewToolSignalKind {
  const lower = name.toLowerCase();
  if (/(typecheck|tsc|types|type-check)/.test(lower)) return "typecheck";
  if (/(test|vitest|jest|spec)/.test(lower)) return "test";
  if (/(lint|eslint|stylelint|prettier|tsfmt)/.test(lower)) return "lint";
  if (/(build|bundle|compile|webpack|vite|rollup|tsup)/.test(lower)) return "build";
  return "ci_check";
}

function signalKindFromPayloadSignal(signal: ValidationSignalSource): ReviewToolSignalKind {
  switch (signal.kind) {
    case "pr_check_failure":
      return "ci_check";
    case "test_run_failure":
      return "test";
    case "review_feedback":
      return "validation";
    case "session_failure":
      return "validation";
    default:
      return "validation";
  }
}

function pathMatchesFinding(paths: string[], findingPath: string | null): boolean {
  if (!findingPath || paths.length === 0) return false;
  const normalized = findingPath.replace(/^\.+\//, "");
  return paths.some((candidate) => {
    const normalizedCandidate = candidate.replace(/^\.+\//, "");
    return normalizedCandidate === normalized
      || normalizedCandidate.endsWith(`/${normalized}`)
      || normalized.endsWith(`/${normalizedCandidate}`);
  });
}

function titleMatchesSignal(findingTitle: string, findingBody: string, summary: string): boolean {
  const haystack = `${findingTitle} ${findingBody}`.toLowerCase();
  const tokens = summary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
  if (tokens.length === 0) return false;
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

export function buildToolBackedEvidence(args: {
  finding: Pick<ReviewFinding, "filePath" | "title" | "body" | "line">;
  validation: ReviewContextValidationPayload | null;
  artifactIdByKey?: Partial<Record<"validation_signals", string>>;
}): ReviewEvidence[] {
  if (!args.validation) return [];
  const out: ReviewEvidence[] = [];
  const artifactId = args.artifactIdByKey?.validation_signals ?? null;

  for (const signal of args.validation.signals) {
    const matches = pathMatchesFinding(signal.filePaths, args.finding.filePath);
    const titleHit = !matches && titleMatchesSignal(args.finding.title, args.finding.body, signal.summary);
    if (!matches && !titleHit) continue;
    const kind: ReviewToolSignalKind = signalKindFromPayloadSignal(signal);
    out.push({
      kind: "tool_signal",
      summary: signal.summary,
      filePath: signal.filePaths[0] ?? null,
      line: null,
      quote: null,
      artifactId,
      toolSignal: {
        kind,
        source: signal.sourceId,
        status: STATUS_BY_KIND[kind],
        detail: signal.summary,
      },
    });
    if (out.length >= 3) return out;
  }

  for (const check of args.validation.checks) {
    if (check.conclusion && check.conclusion !== "failure" && check.conclusion !== "action_required") continue;
    const kind = classifyCheck(check.name);
    const detail = `${check.name} (${check.status}${check.conclusion ? ` / ${check.conclusion}` : ""})`;
    const matchesTitle = titleMatchesSignal(args.finding.title, args.finding.body, check.name);
    if (!matchesTitle && out.length > 0) continue;
    out.push({
      kind: "tool_signal",
      summary: `CI check ${detail}`,
      filePath: null,
      line: null,
      quote: null,
      artifactId,
      toolSignal: {
        kind,
        source: check.detailsUrl ?? check.name,
        status: check.conclusion === "failure" ? "fail" : "warn",
        detail,
      },
    });
    if (out.length >= 3) return out;
  }

  for (const testRun of args.validation.testRuns) {
    if (testRun.status !== "failed" && testRun.status !== "error") continue;
    const hitLog = testRun.logExcerpt
      ? titleMatchesSignal(args.finding.title, args.finding.body, testRun.logExcerpt)
      : false;
    if (!hitLog && out.length > 0) continue;
    out.push({
      kind: "tool_signal",
      summary: `Test run ${testRun.suiteName} — ${testRun.status}${testRun.exitCode != null ? ` (exit ${testRun.exitCode})` : ""}`,
      filePath: null,
      line: null,
      quote: testRun.logExcerpt,
      artifactId,
      toolSignal: {
        kind: "test",
        source: `test-run:${testRun.runId}`,
        status: "fail",
        detail: testRun.logExcerpt ?? null,
      },
    });
    if (out.length >= 3) return out;
  }

  return out;
}
