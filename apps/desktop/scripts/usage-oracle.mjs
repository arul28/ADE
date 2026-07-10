#!/usr/bin/env -S npx tsx

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _testing } from "../src/main/services/usage/usageTrackingService.ts";

const PROVIDERS = ["claude", "codex", "cursor", "gemini", "droid", "opencode", "copilot"];
const NATIVE_PROVIDERS = new Set(["claude", "codex", "gemini", "opencode"]);
const METRICS = ["input", "output", "cacheRead"];
const DEFAULT_CLOSED_RANGE = { label: "closed", from: "2026-07-01", to: "2026-07-09" };

const NATIVE_DIAGNOSES = {
  claude: "Recursive Claude workflow-subagent discovery is enabled; remaining variance needs a sampled-ledger review.",
  gemini: "Gemini uses native message token fields; remaining variance needs a sampled-session review.",
  opencode: "OpenCode uses native SQLite message token fields; remaining variance needs a sampled-row review.",
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function requireDirectory(value, label) {
  if (!value || !fs.existsSync(value) || !fs.statSync(value).isDirectory()) {
    throw new Error(`${label} is required and must be a directory: ${value ?? "(unset)"}`);
  }
  return path.resolve(value);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function codeburnEnvironment() {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
}

function runCodeburnReport(codeburnDir, range, provider) {
  const args = [
    path.join(codeburnDir, "dist", "cli.js"),
    "report",
    "--from", range.from,
    "--to", range.to,
    "--format", "json",
  ];
  if (provider) args.push("--provider", provider);
  const raw = execFileSync(process.execPath, args, {
    cwd: codeburnDir,
    encoding: "utf8",
    env: codeburnEnvironment(),
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(raw);
}

function runCodeburnDailyExport(codeburnDir, range, provider) {
  const tempPath = path.join(os.tmpdir(), `ade-codeburn-export-${process.pid}-${provider}-${range.label}-${Date.now()}.json`);
  try {
    execFileSync(process.execPath, [
      path.join(codeburnDir, "dist", "cli.js"),
      "export",
      "--from", range.from,
      "--to", range.to,
      "--provider", provider,
      "--format", "json",
      "--output", tempPath,
    ], {
      cwd: codeburnDir,
      encoding: "utf8",
      env: codeburnEnvironment(),
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const report = JSON.parse(fs.readFileSync(tempPath, "utf8"));
    return report.periods?.[0]?.daily ?? [];
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function sumBreakdown(breakdown) {
  return Object.values(breakdown ?? {}).reduce((total, model) => ({
    input: total.input + Number(model.input ?? 0),
    output: total.output + Number(model.output ?? 0),
    cacheRead: total.cacheRead + Number(model.cached ?? 0),
  }), { input: 0, output: 0, cacheRead: 0 });
}

function filterEntries(entries, range, localDayKey) {
  return entries.filter((entry) => {
    const day = localDayKey(entry.timestamp);
    return day && day >= range.from && day <= range.to;
  });
}

function summarizeAde(entries, provider, range, aggregateCosts, buildCostSnapshots, localDayKey) {
  const filtered = filterEntries(entries, range, localDayKey);
  const adeOriginatedEntries = filtered.filter((entry) => (
    entry.adeOriginated || entry.originator?.trim().toLowerCase().startsWith("ade")
  ));
  const aggregate = aggregateCosts(filtered, provider);
  const adeOriginatedAggregate = aggregateCosts(adeOriginatedEntries, provider);
  const built = buildCostSnapshots(new Map([[provider, filtered]]), "machine", null)[0];
  const totals = sumBreakdown(aggregate.tokenBreakdownByPreset?.all);
  const daily = Object.fromEntries(Object.entries(aggregate.dailyTokenBreakdownByPreset?.all ?? {})
    .map(([day, breakdown]) => [day, sumBreakdown(breakdown)]));
  return {
    ...totals,
    entries: filtered.length,
    daily,
    estimation: built?.estimation ?? null,
    adeOriginatedTokens: built?.adeOriginatedTokensByPreset?.all ?? 0,
    adeOriginated: sumBreakdown(adeOriginatedAggregate.tokenBreakdownByPreset?.all),
  };
}

function summarizeCodeburn(report) {
  const tokens = report.overview?.tokens ?? {};
  return {
    input: Number(tokens.input ?? 0),
    output: Number(tokens.output ?? 0),
    cacheRead: Number(tokens.cacheRead ?? 0),
  };
}

function compareTotals(ade, codeburn) {
  return Object.fromEntries(METRICS.map((metric) => {
    const absolute = Math.abs(ade[metric] - codeburn[metric]);
    const percent = codeburn[metric] === 0
      ? absolute === 0 ? 0 : Number.POSITIVE_INFINITY
      : absolute / codeburn[metric] * 100;
    return [metric, { ade: ade[metric], codeburn: codeburn[metric], absolute, percent }];
  }));
}

function diagnosisFor(provider, ade, codeburn) {
  if (provider !== "codex") return NATIVE_DIAGNOSES[provider];
  const externalOnly = Object.fromEntries(METRICS.map((metric) => [
    metric,
    Math.max(0, ade[metric] - (ade.adeOriginated?.[metric] ?? 0)),
  ]));
  const externalComparison = compareTotals(externalOnly, codeburn);
  return "Fixed recursive history truncation, cached-input double counting, and reasoning/output conflation. " +
    "The remaining table delta is expected because ADE includes ADE-originated Codex sessions while codeburn only accepts `codex*` originators; " +
    `external-only deltas are input ${formatPercent(externalComparison.input.percent)}, output ${formatPercent(externalComparison.output.percent)}, and cache read ${formatPercent(externalComparison.cacheRead.percent)}.`;
}

function largestDailyDelta(adeDaily, codeburnDaily) {
  const codeburnByDay = Object.fromEntries(codeburnDaily.map((row) => [row.Date, {
    input: Number(row["Input Tokens"] ?? 0),
    output: Number(row["Output Tokens"] ?? 0),
    cacheRead: Number(row["Cache Read Tokens"] ?? 0),
  }]));
  const days = new Set([...Object.keys(adeDaily), ...Object.keys(codeburnByDay)]);
  let largest = null;
  for (const day of days) {
    const ade = adeDaily[day] ?? { input: 0, output: 0, cacheRead: 0 };
    const codeburn = codeburnByDay[day] ?? { input: 0, output: 0, cacheRead: 0 };
    const absolute = METRICS.reduce((sum, metric) => sum + Math.abs(ade[metric] - codeburn[metric]), 0);
    if (!largest || absolute > largest.absolute) largest = { day, absolute, ade, codeburn };
  }
  return largest;
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : "∞";
}

function tableForRange(range, comparisons) {
  const lines = [
    `### ${range.label === "closed" ? `${range.from} through ${range.to}` : `Today (${range.from})`}`,
    "",
    "| Provider | ADE input | codeburn input | Abs Δ | Δ% | ADE output | codeburn output | Abs Δ | Δ% | ADE cache read | codeburn cache read | Abs Δ | Δ% |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const provider of PROVIDERS) {
    const result = comparisons[provider];
    lines.push(`| ${provider} | ${formatInteger(result.input.ade)} | ${formatInteger(result.input.codeburn)} | ${formatInteger(result.input.absolute)} | ${formatPercent(result.input.percent)} | ${formatInteger(result.output.ade)} | ${formatInteger(result.output.codeburn)} | ${formatInteger(result.output.absolute)} | ${formatPercent(result.output.percent)} | ${formatInteger(result.cacheRead.ade)} | ${formatInteger(result.cacheRead.codeburn)} | ${formatInteger(result.cacheRead.absolute)} | ${formatPercent(result.cacheRead.percent)} |`);
  }
  return lines.join("\n");
}

async function scanAdeLedgers() {
  const {
    scanClaudeLogs,
    scanCodexLogs,
    scanCursorLogs,
    scanGeminiLogs,
    scanDroidLogs,
    scanOpenCodeLogs,
    scanCopilotLogs,
  } = _testing;
  const values = await Promise.all([
    scanClaudeLogs(),
    scanCodexLogs(),
    scanCursorLogs(),
    scanGeminiLogs(),
    scanDroidLogs(),
    scanOpenCodeLogs(),
    scanCopilotLogs(),
  ]);
  return new Map(PROVIDERS.map((provider, index) => [provider, values[index]]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const codeburnDir = requireDirectory(args["codeburn-dir"] ?? process.env.CODEBURN_DIR, "--codeburn-dir/CODEBURN_DIR");
  const outputDir = path.resolve(args["output-dir"] ?? process.env.USAGE_ORACLE_OUTPUT_DIR ?? path.join(os.tmpdir(), "ade-usage-oracle"));
  fs.mkdirSync(outputDir, { recursive: true });

  const closedRange = {
    ...DEFAULT_CLOSED_RANGE,
    from: args.from ?? DEFAULT_CLOSED_RANGE.from,
    to: args.to ?? DEFAULT_CLOSED_RANGE.to,
  };
  const todayKey = _testing.localDayKey(Date.now());
  const ranges = [closedRange, { label: "today", from: todayKey, to: todayKey }];
  const generatedAt = new Date().toISOString();

  process.stderr.write("Scanning ADE provider ledgers...\n");
  const adeEntries = await scanAdeLedgers();
  const adeByRange = {};
  for (const range of ranges) {
    adeByRange[range.label] = Object.fromEntries(PROVIDERS.map((provider) => [provider, summarizeAde(
      adeEntries.get(provider) ?? [],
      provider,
      range,
      _testing.aggregateCosts,
      _testing.buildCostSnapshots,
      _testing.localDayKey,
    )]));
  }

  const providerReports = {};
  const comparisonsByRange = {};
  for (const range of ranges) {
    process.stderr.write(`Capturing codeburn ${range.label} provider reports...\n`);
    providerReports[range.label] = {};
    comparisonsByRange[range.label] = {};
    for (const provider of PROVIDERS) {
      const report = runCodeburnReport(codeburnDir, range, provider);
      providerReports[range.label][provider] = report;
      comparisonsByRange[range.label][provider] = compareTotals(
        adeByRange[range.label][provider],
        summarizeCodeburn(report),
      );
    }
  }

  process.stderr.write("Capturing combined codeburn reports...\n");
  const combinedReports = Object.fromEntries(ranges.map((range) => [range.label, runCodeburnReport(codeburnDir, range)]));
  writeJson(path.join(outputDir, "codeburn-oracle-range.json"), combinedReports.closed);
  writeJson(path.join(outputDir, "codeburn-oracle-today.json"), combinedReports.today);

  const diagnostics = [];
  for (const range of ranges) {
    for (const provider of PROVIDERS.filter((value) => NATIVE_PROVIDERS.has(value))) {
      const comparison = comparisonsByRange[range.label][provider];
      if (!METRICS.some((metric) => comparison[metric].percent > 1)) continue;
      process.stderr.write(`Sampling codeburn daily totals for ${provider} (${range.label})...\n`);
      const daily = runCodeburnDailyExport(codeburnDir, range, provider);
      diagnostics.push({
        range: range.label,
        provider,
        diagnosis: diagnosisFor(
          provider,
          adeByRange[range.label][provider],
          summarizeCodeburn(providerReports[range.label][provider]),
        ),
        largestDailyDelta: largestDailyDelta(adeByRange[range.label][provider].daily, daily),
      });
    }
  }

  const capture = {
    generatedAt,
    desktopRoot: path.resolve(scriptDir, ".."),
    codeburnDir,
    ranges,
    ade: adeByRange,
    codeburn: providerReports,
    comparisons: comparisonsByRange,
    diagnostics,
  };
  writeJson(path.join(outputDir, "usage-oracle-captures.json"), capture);

  const diagnosisLines = diagnostics.length === 0
    ? ["- None; every native-count provider is within 1% for input, output, and cache read."]
    : diagnostics.map((diagnostic) => {
      const sample = diagnostic.largestDailyDelta
        ? ` Largest sampled day: ${diagnostic.largestDailyDelta.day}.`
        : "";
      return `- **${diagnostic.provider} (${diagnostic.range})** — ${diagnostic.diagnosis}${sample}`;
    });
  const markdown = [
    "# ADE usage accuracy oracle",
    "",
    `Generated: ${generatedAt}`,
    `Closed range: ${closedRange.from} through ${closedRange.to}, inclusive (machine-local days).`,
    `Today: ${todayKey} (in progress; provider ledgers can change during capture).`,
    "Token fields only; dollar totals are intentionally ignored. Absolute deltas are unsigned.",
    "",
    tableForRange(closedRange, comparisonsByRange.closed),
    "",
    tableForRange(ranges[1], comparisonsByRange.today),
    "",
    "## Native-provider diagnoses (>1%)",
    "",
    ...diagnosisLines,
    "",
    "## Estimated-provider note",
    "",
    "Cursor, Droid, and Copilot use provider-specific estimates or session-level distribution in at least one tool. Their deltas are reported but are not parity gates.",
    "",
  ].join("\n");

  const resultPath = path.join(outputDir, "oracle-results.md");
  fs.writeFileSync(resultPath, markdown);
  process.stdout.write(markdown);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
