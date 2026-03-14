import { stripAnsi } from "./ansiStrip";

type ParsedTestSummary = {
  status: "PASS" | "FAIL";
  testsTotal: number | null;
  durationText: string | null;
};

function clip(text: string, max = 140): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function findLikelyCommand(lines: string[]): string | null {
  // Typical prompts: "$ cmd", "❯ cmd", "# cmd"
  const promptRegex = /^(?:\$|❯|#|>)\s+(.+)$/;
  // npm/pnpm script header: "> pkg@1.0.0 test" (including scoped packages).
  const npmScriptHeaderRegex = /^>\s+(?:@[^/\s]+\/)?[^\s@]+@[^\s]+\s+([^\s]+)\s*$/;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (npmScriptHeaderRegex.test(line)) continue;
    const match = line.match(promptRegex);
    if (!match) continue;
    const cmd = match[1]?.trim() ?? "";
    if (!cmd) continue;
    if (cmd.toLowerCase() === "clear") continue;
    return clip(cmd, 160);
  }

  // npm/pnpm script header: "> pkg@1.0.0 test"
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    const match = line.match(npmScriptHeaderRegex);
    if (!match) continue;
    const script = match[1]?.trim() ?? "";
    if (!script) continue;
    return `npm run ${script}`;
  }

  return null;
}

function parseTestSummary(lines: string[]): ParsedTestSummary | null {
  // Jest: "Tests: 1 failed, 2 passed, 3 total"
  for (const line of lines) {
    if (!/^Tests:\s+/i.test(line)) continue;
    const passed = Number(line.match(/(\d+)\s+passed/i)?.[1] ?? NaN);
    const failed = Number(line.match(/(\d+)\s+failed/i)?.[1] ?? NaN);
    const total = Number(line.match(/(\d+)\s+total/i)?.[1] ?? NaN);
    const testsTotal = Number.isFinite(total) ? total : Number.isFinite(passed) ? passed : null;
    const status: ParsedTestSummary["status"] = Number.isFinite(failed) && failed > 0 ? "FAIL" : "PASS";
    return { status, testsTotal, durationText: null };
  }

  // Vitest: "Tests  2 passed (2)" / "Tests  1 failed (1)"
  let testsLine: string | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (!/\bTests?\b/i.test(line)) continue;
    if (!/\b(passed|failed)\b/i.test(line)) continue;
    testsLine = line;
    break;
  }
  if (testsLine) {
    const passed = Number(testsLine.match(/(\d+)\s+passed/i)?.[1] ?? NaN);
    const failed = Number(testsLine.match(/(\d+)\s+failed/i)?.[1] ?? NaN);
    const total = Number(testsLine.match(/\((\d+)\)\s*$/)?.[1] ?? NaN);
    const testsTotal = Number.isFinite(total) ? total : Number.isFinite(passed) ? passed : null;
    const status: ParsedTestSummary["status"] = Number.isFinite(failed) && failed > 0 ? "FAIL" : "PASS";

    let durationText: string | null = null;
    const durationLine = lines.find((l) => /^Duration\b/i.test(l)) ?? null;
    if (durationLine) {
      const match = durationLine.match(/(\d+(?:\.\d+)?)(ms|s)\b/i);
      if (match) durationText = `${match[1]}${match[2]}`;
    }

    return { status, testsTotal, durationText };
  }

  // pytest: "== 2 passed in 0.07s =="
  for (const line of lines) {
    const match = line.match(/\b(\d+)\s+passed\b.*\bin\s+(\d+(?:\.\d+)?)s\b/i);
    if (!match) continue;
    return { status: "PASS", testsTotal: Number(match[1]), durationText: `${match[2]}s` };
  }

  return null;
}

function findFailureHint(lines: string[]): string | null {
  const patterns = [
    /\bEACCES\b/i,
    /\bENOENT\b/i,
    /\bpermission denied\b/i,
    /\bTypeError:\b/i,
    /\bReferenceError:\b/i,
    /\bSyntaxError:\b/i,
    /\bTraceback\b/i,
    /\bfatal:\b/i,
    /^\s*error:\s+/i,
    /\bfailed\b/i
  ];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    if (patterns.some((re) => re.test(line))) return clip(line, 120);
  }
  return null;
}

export function summarizeTerminalSession(args: {
  title: string;
  goal?: string | null;
  toolType?: string | null;
  exitCode: number | null;
  transcript?: string;
}): string {
  const title = (args.title ?? "").trim();
  const goal = (args.goal ?? "").trim();
  const intent = goal || title || "terminal session";

  const transcript = stripAnsi(args.transcript ?? "");
  const lines = transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-320);

  const cmd = findLikelyCommand(lines) ?? intent;
  const prefix = cmd.toLowerCase().startsWith("ran ") ? cmd : `Ran ${cmd}`;

  const test = parseTestSummary(lines);
  if (test) {
    const testsSuffix = test.testsTotal != null ? `, ${test.testsTotal} tests` : "";
    const durationSuffix = test.durationText ? `, ${test.durationText}` : "";
    return `${prefix} (${test.status}${testsSuffix}${durationSuffix})`;
  }

  if (args.exitCode == null) {
    // Exit code unknown; keep it short.
    return `${prefix} (ENDED)`;
  }
  if (args.exitCode === 0) {
    return `${prefix} (OK)`;
  }

  const hint = findFailureHint(lines);
  return `${prefix} (FAIL, exit code ${args.exitCode}${hint ? `, ${hint}` : ""})`;
}
