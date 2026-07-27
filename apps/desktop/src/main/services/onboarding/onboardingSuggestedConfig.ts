import path from "node:path";
import YAML from "yaml";
import type {
  OnboardingDetectionIndicator,
  ProjectConfigFile,
  TestSuiteTag,
} from "../../../shared/types";
import { fileExists, safeReadText } from "../shared/utils";

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = item.id.trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

export function parseGithubWorkflowRuns(absPath: string): string[] {
  const raw = safeReadText(absPath, 220_000);
  if (!raw.trim()) return [];
  try {
    const parsed = YAML.parse(raw) as { jobs?: Record<string, { steps?: Array<{ run?: unknown }> }> } | null;
    const jobs = parsed?.jobs;
    if (!jobs || typeof jobs !== "object") return [];
    const commands: string[] = [];
    for (const job of Object.values(jobs)) {
      const steps = job?.steps;
      if (!Array.isArray(steps)) continue;
      for (const step of steps) {
        const run = typeof step.run === "string" ? step.run.trim() : "";
        if (!run) continue;
        const first = run.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
        if (first) commands.push(first);
      }
    }
    return commands;
  } catch {
    return [];
  }
}

function guessNodePackageManager(projectRoot: string): "npm" | "yarn" | "pnpm" {
  if (fileExists(path.join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (fileExists(path.join(projectRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

export function splitShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens.length > 0 ? tokens : [command.trim()];
}

export function buildSuggestedConfig(args: {
  projectRoot: string;
  indicators: OnboardingDetectionIndicator[];
  suggestedWorkflowCommands: string[];
}): ProjectConfigFile {
  const out: ProjectConfigFile = {
    version: 1,
    testSuites: [],
    laneOverlayPolicies: [],
    automations: []
  };

  const addTest = (id: string, name: string, command: string[], cwd = ".", tags: TestSuiteTag[] = ["custom"]) => {
    out.testSuites!.push({ id, name, command, cwd, tags });
  };

  const has = (type: string) => args.indicators.some((ind) => ind.type === type);

  if (has("node")) {
    const pm = guessNodePackageManager(args.projectRoot);
    if (pm === "pnpm") {
      addTest("unit", "Unit tests", ["pnpm", "test"], ".", ["unit"]);
    } else if (pm === "yarn") {
      addTest("unit", "Unit tests", ["yarn", "test"], ".", ["unit"]);
    } else {
      addTest("unit", "Unit tests", ["npm", "test"], ".", ["unit"]);
    }
  }

  if (has("make")) {
    addTest("make-test", "Make test", ["make", "test"], ".", ["custom"]);
  }

  if (has("rust")) {
    addTest("cargo-test", "Cargo test", ["cargo", "test"], ".", ["unit"]);
  }

  if (has("go")) {
    addTest("go-test", "Go test", ["go", "test", "./..."], ".", ["unit"]);
  }

  if (has("python")) {
    addTest("pytest", "Pytest", ["pytest"], ".", ["unit"]);
  }

  const ciCandidates = args.suggestedWorkflowCommands
    .map((cmd) => cmd.trim())
    .filter(Boolean)
    .filter((cmd) =>
      /(npm|pnpm|yarn)\s+(test|run\s+test|lint|run\s+lint)|go\s+test|cargo\s+test|pytest|make\s+test/i.test(cmd)
    )
    .slice(0, 6);
  for (const [idx, cmd] of ciCandidates.entries()) {
    const id = `ci-${idx + 1}`;
    addTest(id, `CI: ${cmd}`, splitShellCommand(cmd), ".", ["custom"]);
  }

  out.testSuites = uniqueById(out.testSuites ?? []);

  out.automations = [
    {
      id: "session-end-local",
      name: "Session end: predict conflicts",
      enabled: true,
      trigger: { type: "session-end" },
      actions: [
        { type: "predict-conflicts" }
      ]
    }
  ];

  out.providers = {
    contextTools: {
      generators: {
        codex: {
          command: ["codex", "exec", "-"]
        },
        claude: {
          command: ["claude", "--print"]
        }
      },
      conflictResolvers: {
        codex: {
          command: ["codex", "exec", "-"]
        },
        claude: {
          command: ["claude", "--print"]
        }
      }
    }
  };

  return out;
}
