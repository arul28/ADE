/**
 * A stdio MCP server that looks like ADE MCP to the model under test: the
 * real instructions and tool list (from the real protocol), and typed tool
 * results from the real result builder (`buildTypedToolResult`) over a
 * scripted command run instead of a running ADE. The real argument checks and
 * command policy run first, so what ADE refuses is refused here too.
 *
 *   tsx fakeServer.ts --cases cases.ndjson --case <id> --log <calls.ndjson>
 */
import fs from "node:fs";
import readline from "node:readline";
import type { RemoteMcpMachineRouter } from "../../apps/ade-cli/src/services/remoteMcp/remoteMcpForward";
import { createRemoteMcpProtocol } from "../../apps/ade-cli/src/services/remoteMcp/remoteMcpProtocol";
import type { RemoteRunResult } from "../../apps/ade-cli/src/services/remoteMcp/remoteMcpRunner";
import {
  buildTypedToolResult,
  findTypedTool,
  MACHINES_TOOL_NAME,
} from "../../apps/ade-cli/src/services/remoteMcp/remoteMcpTools";
import { checkRemoteAdeCommand, splitCommandLine } from "../../apps/ade-cli/src/services/remoteMcp/remoteMcpCommandPolicy";
import type { RemoteMcpConnectionSummary } from "../../apps/desktop/src/shared/types/remoteMcp";
import { DEFAULT_RESULTS, MACHINES, PROJECTS, type Input } from "./fixtures";
import type { EvalCase } from "./run";

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`fakeServer needs ${name}`);
  return value;
}

const caseId = arg("--case");
const logPath = arg("--log");
const evalCase = fs.readFileSync(arg("--cases"), "utf8").split("\n").filter((line) => line.trim())
  .map((line) => JSON.parse(line) as EvalCase).find((entry) => entry.id === caseId);
if (!evalCase) throw new Error(`No case ${caseId}`);
const scope = evalCase.scope;
const connection = { id: "eval", label: "eval", scope } as RemoteMcpConnectionSummary;

// The account's computers, so the tool list carries `machine` the way a
// signed-in brain serves it (the router is only read for its shape here).
const machineRouter: RemoteMcpMachineRouter = {
  thisMachine: () => ({ key: MACHINES[0]!.key, name: MACHINES[0]!.name }),
  roster: async () => [],
  resolve: async () => ({ kind: "error", message: "" }),
  unavailableReason: () => null,
  forward: async () => ({ content: [] }),
};
const protocol = createRemoteMcpProtocol({
  machineName: () => MACHINES[0]!.name,
  listProjects: () => PROJECTS.map(({ projectId, displayName, rootPath, lastOpenedAt }) => ({ projectId, displayName, rootPath, lastOpenedAt })),
  record: () => {},
  machines: machineRouter,
});

const LANE_IDS = new Set(["lane-main", "lane-fix-login", "lane-deps", "lane-new"]);
const SESSION_IDS = new Set(["chat-login", "chat-deps", "chat-new"]);

const served = new Map<string, number>();
/** The scripted output for a tool: the case's responses in order (the last repeats), else the world default. */
function scripted(tool: string, input: Input): unknown {
  const list = evalCase!.results?.[tool];
  if (list?.length) {
    const count = served.get(tool) ?? 0;
    served.set(tool, count + 1);
    return list[Math.min(count, list.length - 1)];
  }
  const fallback = DEFAULT_RESULTS[tool];
  return typeof fallback === "function" ? (fallback as (input: Input) => unknown)(input) : fallback;
}

function projectFor(input: Input): typeof PROJECTS[number] | { error: string } {
  const wanted = typeof input.project === "string" ? input.project.trim().toLowerCase() : "";
  if (!wanted) return PROJECTS[0]!;
  const found = PROJECTS.find((project) =>
    [project.projectId, project.displayName, project.rootPath].some((value) => value.toLowerCase() === wanted));
  return found ?? { error: `No project "${input.project}" on this computer. Projects: ${PROJECTS.map((p) => p.displayName).join(", ")}.` };
}

const errorResult = (text: string) => ({ content: [{ type: "text", text }], isError: true });

/** What the CLI would have printed: scripted stdout, or a failure on stderr. */
function scriptedRun(stdout: string, exitCode = 0, stderr = ""): RemoteRunResult {
  return { exitCode, stdout, stderr, timedOut: false, truncated: false, durationMs: 0 };
}

function callTool(name: string, rawInput: Input): Record<string, unknown> {
  const { machine, ...input } = rawInput;
  let machineLine = "";
  if (typeof machine === "string" && machine.trim()) {
    const target = MACHINES.find((entry) => [entry.name, entry.key].some((value) => value.toLowerCase() === machine.trim().toLowerCase()));
    if (machine.trim().toLowerCase() !== "all" && !target) {
      return errorResult(`No computer "${machine}" on this account. Computers: ${MACHINES.map((entry) => entry.name).join(", ")}.`);
    }
    if (target && !target.isThisMachine) machineLine = `[machine: ${target.name}]\n`;
  }
  if (name === MACHINES_TOOL_NAME) {
    const result = scripted(name, input);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: { view: MACHINES_TOOL_NAME, ...(result && typeof result === "object" ? result : {}) },
    };
  }
  const project = projectFor(input);
  if ("error" in project) return errorResult(project.error);
  const projectLine = `${machineLine}[project: ${project.displayName} · ${project.projectId} · ${project.rootPath}]`;
  const typed = name === "ade" ? null : findTypedTool(name);
  if (name !== "ade" && !typed) return errorResult(`Unknown tool "${name}".`);
  if (typed?.write && scope !== "write") {
    return errorResult(`${projectLine}\nThis connection is read-only, so it can't run ${typed.name}. The person can give this app full access in ADE Settings → ADE MCP.`);
  }
  let words: unknown = input.args;
  if (typed) {
    const built = typed.build(input);
    if ("error" in built) return errorResult(`${projectLine}\n${built.error}`);
    words = built.argv;
  } else if (words === undefined && typeof input.command === "string") {
    words = splitCommandLine(input.command);
  }
  const verdict = checkRemoteAdeCommand(words, scope, { hasStdin: typeof input.stdin === "string" });
  if (!verdict.ok) return errorResult(`${projectLine}\n${verdict.reason}`);
  if (!typed) {
    const line = verdict.args.join(" ");
    const hit = (evalCase!.ade ?? []).find((entry) => new RegExp(entry.match, "i").test(line));
    return { content: [{ type: "text", text: `${projectLine}\n${hit?.text ?? "(no output)"}` }], isError: Boolean(hit?.isError) };
  }
  const frame = { headLine: projectLine, project: { id: project.projectId, name: project.displayName, path: project.rootPath } };
  // The CLI takes ids, not names: an unknown one fails the way ADE fails it.
  if (typeof input.lane === "string" && !LANE_IDS.has(input.lane)) {
    return buildTypedToolResult(typed, input, scriptedRun("", 1, `ade: Lane not found: ${input.lane}`), frame);
  }
  if (typeof input.session === "string" && !SESSION_IDS.has(input.session)) {
    return buildTypedToolResult(typed, input, scriptedRun("", 1, `ade: Chat session '${input.session}' was not found.`), frame);
  }
  const output = scripted(name, input);
  if (output === undefined) return errorResult(`${projectLine}\n(the eval has no scripted output for ${name})`);
  if (output && typeof output === "object" && "$error" in output) {
    return buildTypedToolResult(typed, input, scriptedRun("", 1, String((output as { $error: unknown }).$error)), frame);
  }
  return buildTypedToolResult(typed, input, scriptedRun(JSON.stringify(output)), frame);
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown> };
  if (message.id === undefined || message.id === null) return;
  let response: unknown;
  if (message.method === "tools/call") {
    const name = String(message.params?.name ?? "");
    const input = (message.params?.arguments ?? {}) as Input;
    const result = callTool(name, input);
    fs.appendFileSync(logPath, `${JSON.stringify({ name, arguments: input, isError: result.isError === true })}\n`);
    response = { jsonrpc: "2.0", id: message.id, result };
  } else if (message.method === "resources/list" || message.method === "prompts/list" || message.method === "resources/templates/list") {
    const key = message.method === "prompts/list" ? "prompts" : message.method === "resources/list" ? "resources" : "resourceTemplates";
    response = { jsonrpc: "2.0", id: message.id, result: { [key]: [] } };
  } else {
    response = await protocol.handleRpc(connection, { jsonrpc: "2.0", ...message });
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
