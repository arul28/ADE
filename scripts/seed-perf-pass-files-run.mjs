#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const repo = process.argv[2] ?? process.env.ADE_PERF_PASS_DIR ?? join(homedir(), "Projects", "perf pass");

function git(args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(relativePath, content) {
  const path = join(repo, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

if (!existsSync(join(repo, ".git"))) {
  console.error(`[seed] ${repo} is not a git repo`);
  process.exit(2);
}

rmSync(join(repo, "src"), { recursive: true, force: true });
rmSync(join(repo, "docs"), { recursive: true, force: true });
rmSync(join(repo, "scripts"), { recursive: true, force: true });
rmSync(join(repo, "fixtures"), { recursive: true, force: true });
rmSync(join(repo, "untracked-scratch"), { recursive: true, force: true });
mkdirSync(join(repo, ".ade"), { recursive: true });

write("package.json", `${JSON.stringify({
  name: "ade-perf-pass",
  private: true,
  type: "module",
  scripts: {
    "perf:tick": "node scripts/long-runner.mjs tick 1500",
    "perf:short": "node scripts/short-runner.mjs",
  },
}, null, 2)}\n`);

write("scripts/long-runner.mjs", `const name = process.argv[2] ?? "runner";
const interval = Number(process.argv[3] ?? 1500);
let ticks = 0;
console.log(\`[perf-pass] \${name} started in \${process.cwd()}\`);
setInterval(() => {
  ticks += 1;
  console.log(\`[perf-pass] \${name} tick \${ticks}\`);
}, interval).unref();
setTimeout(() => {
  console.log(\`[perf-pass] \${name} steady idle\`);
}, 250);
setTimeout(() => {}, 10 * 60 * 1000);
`);

write("scripts/short-runner.mjs", `console.log("[perf-pass] short command", process.cwd());
setTimeout(() => console.log("[perf-pass] short done"), 300);
`);

const commandGroups = [
  { id: "web", name: "Web" },
  { id: "api", name: "API" },
  { id: "tests", name: "Tests" },
  { id: "tools", name: "Tools" },
  { id: "stress", name: "Stress" },
];
const commands = Array.from({ length: 36 }, (_, index) => {
  const n = String(index + 1).padStart(2, "0");
  const primaryGroup = commandGroups[index % (commandGroups.length - 1)].id;
  const longRunning = index % 4 !== 0;
  return {
    id: `perf-cmd-${n}`,
    name: `Perf command ${n}`,
    command: longRunning
      ? ["node", "scripts/long-runner.mjs", `cmd-${n}`, String(1200 + index * 17)]
      : ["node", "scripts/short-runner.mjs"],
    cwd: ".",
    groupIds: [primaryGroup, "stress"],
    gracefulShutdownMs: 1500,
    readiness: { type: "none" },
  };
});
const yamlLines = [
  "version: 1",
  "processGroups:",
  ...commandGroups.flatMap((group) => [`  - id: ${group.id}`, `    name: ${group.name}`]),
  "processes:",
  ...commands.flatMap((cmd) => [
    `  - id: ${cmd.id}`,
    `    name: ${cmd.name}`,
    "    command:",
    ...cmd.command.map((part) => `      - ${JSON.stringify(part)}`),
    `    cwd: ${JSON.stringify(cmd.cwd)}`,
    "    groupIds:",
    ...cmd.groupIds.map((groupId) => `      - ${groupId}`),
    `    gracefulShutdownMs: ${cmd.gracefulShutdownMs}`,
    "    readiness:",
    "      type: none",
  ]),
  "",
];
write(".ade/ade.yaml", yamlLines.join("\n"));

for (let dir = 0; dir < 18; dir += 1) {
  const dirName = `src/feature-${String(dir).padStart(2, "0")}`;
  for (let file = 0; file < 70; file += 1) {
    const fileName = `${dirName}/component-${String(file).padStart(3, "0")}.ts`;
    const needle = file % 9 === 0 ? "PERF_NEEDLE search target" : "ordinary content";
    write(fileName, [
      `export const feature${dir}Component${file} = ${dir * 1000 + file};`,
      `export const description = "${needle} ${dirName} ${fileName}";`,
      "export function renderLabel(input: string): string {",
      `  return \`${dirName}:${file}:\${input.toUpperCase()}\`;`,
      "}",
      "",
    ].join("\n"));
  }
}

for (let doc = 0; doc < 80; doc += 1) {
  write(`docs/audit-note-${String(doc).padStart(3, "0")}.md`, [
    `# Audit note ${doc}`,
    "",
    "This file exists to make quick-open, content search, and tree filtering non-trivial.",
    doc % 7 === 0 ? "PERF_NEEDLE markdown search target." : "Regular markdown body.",
    "",
  ].join("\n"));
}

write("src/conflict-sample.ts", [
  "export const conflict = true;",
  "<<<<<<< ours",
  "export const value = 'ours';",
  "=======",
  "export const value = 'theirs';",
  ">>>>>>> theirs",
  "",
].join("\n"));

write("fixtures/huge-text.txt", `${"PERF_NEEDLE large file line\n".repeat(3000)}\n`);

git(["add", "package.json", "scripts", "src", "docs", "fixtures"]);
const staged = git(["diff", "--cached", "--name-only"]);
if (staged) {
  git(["commit", "-m", "Seed files and run perf fixture"]);
}

write("src/feature-00/component-000.ts", [
  "export const feature0Component0 = 999999;",
  "export const description = \"PERF_NEEDLE modified working tree file\";",
  "export function renderLabel(input: string): string {",
  "  return `modified:${input.toLowerCase()}`;",
  "}",
  "",
].join("\n"));
write("untracked-scratch/new-file-from-seed.ts", "export const scratch = 'untracked PERF_NEEDLE';\n");
rmSync(join(repo, "docs", "audit-note-079.md"), { force: true });

console.log(`[seed] ready at ${repo}`);
console.log(`[seed] files: ${git(["ls-files"]).split("\n").filter(Boolean).length}, dirty entries: ${git(["status", "--short"]).split("\n").filter(Boolean).length}`);
