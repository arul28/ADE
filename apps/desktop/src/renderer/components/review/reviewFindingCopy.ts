import type { ReviewFinding } from "./reviewTypes";
import {
  reviewEvidenceKindLabel,
  reviewFindingClassLabel,
} from "./reviewFindingLabels";

function trimForClipboard(value: string, maxLength = 1_200): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function formatLocation(finding: ReviewFinding): string | null {
  const filePath = finding.filePath?.trim();
  if (!filePath) return null;
  return `${filePath}${finding.line ? `:${finding.line}` : ""}`;
}

export function formatReviewFindingForClipboard(finding: ReviewFinding, index?: number): string {
  const lines: string[] = [];
  const prefix = typeof index === "number" ? `${index}. ` : "";
  lines.push(`${prefix}[${finding.severity.toUpperCase()}] ${finding.title}`);

  const location = formatLocation(finding);
  if (location) lines.push(`Location: ${location}`);

  const findingClass = reviewFindingClassLabel(finding.findingClass ?? null);
  if (findingClass) lines.push(`Risk: ${findingClass.label}`);

  lines.push(`Action: ${finding.body.trim()}`);

  const evidence = finding.evidence ?? [];
  if (evidence.length > 0) {
    lines.push("Evidence:");
    for (const entry of evidence) {
      const parts = [reviewEvidenceKindLabel(entry.kind)];
      if (entry.filePath) parts.push(`${entry.filePath}${entry.line ? `:${entry.line}` : ""}`);
      if (entry.summary?.trim()) parts.push(trimForClipboard(entry.summary, 360));
      lines.push(`- ${parts.join(" - ")}`);
      if (entry.quote?.trim()) {
        lines.push(`  ${trimForClipboard(entry.quote, 500)}`);
      }
    }
  }

  if (finding.adjudication?.rationale?.trim()) {
    lines.push(`Review note: ${finding.adjudication.rationale.trim()}`);
  }

  return lines.join("\n");
}

export function formatReviewFindingsForClipboard(args: {
  findings: ReviewFinding[];
  targetLabel?: string | null;
  summary?: string | null;
}): string {
  const countLabel = `${args.findings.length} ${args.findings.length === 1 ? "finding" : "findings"}`;
  const header = args.targetLabel?.trim()
    ? `Review findings: ${countLabel} from ${args.targetLabel.trim()}`
    : `Review findings: ${countLabel}`;
  const blocks = [header];

  if (args.summary?.trim()) {
    blocks.push(args.summary.trim());
  }

  blocks.push(...args.findings.map((finding, index) => formatReviewFindingForClipboard(finding, index + 1)));
  return blocks.join("\n\n");
}
