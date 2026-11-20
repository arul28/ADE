/**
 * The text of `ade cloud lanes|chats|sessions|backups|jobs|project`: the
 * account's lanes (on a computer, or its computer deleted), saved chats, CLI
 * copies, lane backups, server jobs and one project's view. `--json` prints
 * the action's answer as it is.
 *
 * Split from `cli.ts`, which keeps the formatter switch. The import cycle rule
 * of `cliMacDesktopFormat.ts` applies to `./cli`:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 */
import { parseAgentChatTranscript } from "../../desktop/src/shared/chatTranscript";
import { PRIMARY_LANE_DISPLAY_NAME } from "../../desktop/src/shared/laneDisplayName";
import { isRecord } from "./cli";

type Row = Record<string, unknown>;

const resultOf = (value: unknown): unknown => (isRecord(value) && "result" in value ? value.result : value);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** "Nov 20" from an ISO time or epoch ms, "" when unknown. */
function day(value: unknown): string {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
}

/** Columns padded to the widest cell, two spaces in. */
function table(cells: string[][]): string[] {
  const widths = cells[0]?.map((_, column) => Math.max(...cells.map((row) => (row[column] ?? "").length))) ?? [];
  return cells.map((row) => `  ${row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()}`);
}

const STATE_TEXT: Record<string, string> = {
  awake: "awake",
  asleep: "asleep",
  starting: "starting",
  stopping: "going to sleep",
  deleting: "deleting",
  error: "needs a look",
  computer_deleted: "computer deleted",
};

/** "2 commits, 4 files not on GitHub (saved Nov 18)". */
function backupText(backup: unknown): string {
  if (!isRecord(backup)) return "";
  const commits = typeof backup.commits === "number" ? backup.commits : 0;
  const files = typeof backup.files === "number" ? backup.files : 0;
  if (!commits && !files) return "";
  const parts = [commits ? plural(commits, "commit") : "", files ? plural(files, "file") : ""].filter(Boolean).join(", ");
  return `${parts} not on GitHub (saved ${day(backup.savedAt)})`;
}

/** One lane's line: name, state, size, chats, what is off GitHub, why its computer went. */
function laneCells(lane: Row): string[] {
  const computer = isRecord(lane.computer) ? lane.computer : null;
  const deleted = isRecord(lane.deleted) ? lane.deleted : null;
  const chats = typeof lane.chats === "number" ? lane.chats : 0;
  const due = computer && typeof computer.deletesAt === "string" ? `computer deleted ${day(computer.deletesAt)} unless used or kept` : "";
  return [
    str(lane.name) || str(lane.laneId),
    STATE_TEXT[str(lane.state)] ?? str(lane.state),
    computer ? str(computer.sizeLabel) : "",
    plural(chats, "chat"),
    [due, deleted ? str(deleted.sentence) : "", backupText(lane.backup)].filter(Boolean).join(" · "),
  ];
}

/** `ade cloud lanes`: one list, each lane with its state; the next commands under it. */
export function formatCloudLanes(value: unknown): string {
  const raw = resultOf(value);
  const lanes = rows(isRecord(raw) ? raw.lanes : null);
  const unread = isRecord(raw) && Array.isArray(raw.unread) ? raw.unread.filter((line): line is string => typeof line === "string") : [];
  const lines: string[] = [];
  if (!lanes.length && isRecord(raw) && raw.filtered === true) {
    lines.push("No ADE Cloud lane matches. ade cloud lanes lists them all.");
  } else if (!lanes.length) {
    lines.push("No lanes on ADE Cloud. Start one: ade chat create --machine cloud --provider <p> --model <id> --prompt \"…\".");
  } else {
    // By project, in the order the action gives (awake first, or the biggest disk first for --stale).
    const byProject = new Map<string, Row[]>();
    for (const lane of lanes) {
      const project = str(lane.projectOrigin) || "no project";
      byProject.set(project, [...(byProject.get(project) ?? []), lane]);
    }
    for (const [project, list] of byProject) {
      lines.push(project);
      lines.push(...table(list.map(laneCells)));
      lines.push("");
    }
    const gone = lanes.filter((lane) => lane.state === "computer_deleted").length;
    if (gone) lines.push(`${plural(gone, "lane")} with a deleted computer: the lane and its chats stay, and its next message makes a new computer for it.`);
    lines.push(
      "Next: ade cloud lanes show <lane> · delete <lane> · free <lane> (keep it for later, no computer) · start <lane> · keep <lane> (stop a cleanup)",
    );
  }
  for (const line of unread) lines.push(`Not read: ${line}`);
  return lines.join("\n").trimEnd();
}

/** `ade cloud lanes show <lane>`: the lane, then its saved chats. */
export function formatCloudLane(value: unknown): string {
  const raw = resultOf(value);
  const lane = isRecord(raw) && isRecord(raw.lane) ? raw.lane : null;
  if (!lane) return JSON.stringify(raw, null, 2);
  const computer = isRecord(lane.computer) ? lane.computer : null;
  const deleted = isRecord(lane.deleted) ? lane.deleted : null;
  const facts: Array<[string, string]> = [
    ["Lane", `${str(lane.name)} (${str(lane.laneId)})`],
    ["State", STATE_TEXT[str(lane.state)] ?? str(lane.state)],
    ["Branch", str(lane.branch) || "unknown"],
    ["Project", str(lane.projectOrigin) || "unknown"],
  ];
  if (computer) {
    facts.push(["Computer", `${str(computer.name) || str(computer.instanceId)} · ${str(computer.sizeLabel)}${typeof computer.hoursRate === "number" ? ` · ${computer.hoursRate}× hours` : ""}`]);
    if (str(computer.lastUsedAt)) facts.push(["Last used", day(computer.lastUsedAt)]);
    if (str(computer.deletesAt)) facts.push(["Cleanup", `ADE deletes the computer ${day(computer.deletesAt)} unless it is used or kept (ade cloud lanes keep <lane>)`]);
  }
  if (deleted) facts.push(["Computer", `${str(deleted.sentence)} Its next message makes a new computer for it${str(lane.branch) ? ` on ${str(lane.branch)}` : ""}.`]);
  const backup = backupText(lane.backup);
  if (backup) facts.push(["Saved work", backup]);
  facts.push(["Link", str(lane.link)]);
  const width = Math.max(...facts.map(([label]) => label.length));
  const lines = facts.map(([label, text]) => `${label.padEnd(width)}  ${text}`);
  const chats = rows(isRecord(raw) ? raw.chats : null);
  lines.push("", chats.length ? `Saved chats (ade cloud chats read <id>)` : "No saved chats.");
  lines.push(...(chats.length ? table(chats.map((chat) => [str(chat.title) || "Untitled", str(chat.provider), day(chat.updatedAt), str(chat.chatId)])) : []));
  return lines.join("\n");
}

/** `ade cloud chats`: the account's saved chats. */
export function formatCloudChats(value: unknown): string {
  const raw = resultOf(value);
  const chats = rows(isRecord(raw) ? raw.chats : null);
  if (!chats.length) return "No saved chats on ADE Cloud.";
  const lines = table(chats.map((chat) => {
    const computer = isRecord(chat.computer) ? chat.computer : null;
    return [
      str(chat.title) || "Untitled",
      str(chat.laneName),
      str(chat.provider),
      day(chat.updatedAt),
      computer?.state === "deleted" ? "computer deleted" : "",
      str(chat.chatId),
    ];
  }));
  if (isRecord(raw) && typeof raw.nextCursor === "string") lines.push(`More: ade cloud chats --cursor ${raw.nextCursor}`);
  return lines.join("\n");
}

/** `ade cloud chats read <id>`: the saved chat's messages, oldest first. */
export function formatCloudChatRead(value: unknown): string {
  const raw = resultOf(value);
  if (!isRecord(raw) || !isRecord(raw.chat)) return "ADE Cloud has no such saved chat.";
  const chat = raw.chat;
  const parts = rows(raw.parts);
  const events = parseAgentChatTranscript([...parts].reverse().map((part) => str(part.text)).join(""));
  const lines: string[] = [`${str(chat.title) || "Untitled"} · ${str(chat.provider)} ${str(chat.model)} · ${str(chat.laneName)}`.trim(), ""];
  let agent = "";
  const flush = () => {
    if (agent.trim()) lines.push(`Agent: ${agent.trim()}`, "");
    agent = "";
  };
  for (const { event } of events) {
    if (event.type === "user_message") {
      flush();
      lines.push(`You: ${String(event.text ?? "").trim()}`, "");
    } else if (event.type === "text") {
      agent += String(event.text ?? "");
    } else if (event.type === "done") {
      flush();
    }
  }
  flush();
  if (raw.hasMore === true && typeof raw.nextBefore === "number") lines.push(`Older: ade cloud chats read ${str(chat.chatId)} --before ${raw.nextBefore}`);
  return lines.join("\n").trimEnd();
}

/** `ade cloud sessions`: the saved CLI and shell copies. */
export function formatCloudSessions(value: unknown): string {
  const raw = resultOf(value);
  if (isRecord(raw) && isRecord(raw.session) && typeof raw.text === "string") {
    return `${str(raw.session.title) || str(raw.session.toolType) || "Terminal"} · ${str(raw.session.laneName)}\n\n${raw.text}`;
  }
  const sessions = rows(isRecord(raw) ? raw.sessions : null);
  if (!sessions.length) return "No saved CLI or shell copies on ADE Cloud.";
  const lines = table(sessions.map((session) => [
    str(session.title) || str(session.toolType) || (session.kind === "shell" ? "Shell" : "CLI"),
    str(session.laneName),
    typeof session.lineCount === "number" ? `${session.lineCount} lines` : "",
    day(session.updatedAt),
    str(session.sessionId),
  ]));
  if (isRecord(raw) && typeof raw.nextCursor === "string") lines.push(`More: ade cloud sessions --cursor ${raw.nextCursor}`);
  return lines.join("\n");
}

/** `ade cloud backups`: each lane's work not on GitHub that ADE saved. */
export function formatCloudBackups(value: unknown): string {
  const raw = resultOf(value);
  const backups = rows(isRecord(raw) ? raw.backups : null);
  if (!backups.length) return "ADE Cloud keeps no saved work: every lane's work is on GitHub or on its computer.";
  return [
    ...table(backups.map((backup) => [
      // A computer's main checkout is stored as "Primary"; every screen calls it the main checkout.
      str(backup.laneName).trim().toLowerCase() === "primary" ? PRIMARY_LANE_DISPLAY_NAME : str(backup.laneName) || str(backup.laneId),
      str(backup.branchRef),
      backupText(backup) || "nothing off GitHub",
      backup.restoredAt != null ? `restored ${day(backup.restoredAt)}` : "",
      str(backup.laneId),
    ])),
    "Delete one for good: ade cloud backups forget <lane id>",
  ].join("\n");
}

/** `ade cloud jobs`: launches, moves and copies the server runs. */
export function formatCloudJobs(value: unknown): string {
  const raw = resultOf(value);
  const record = isRecord(raw) ? raw : {};
  const cells: string[][] = [
    ...rows(record.launches).map((job) => ["launch", str(job.laneName) || "lane", str(job.state), day(job.createdAt), str(job.launchId)]),
    ...rows(record.moves).map((job) => ["move", str(job.sourceName), str(job.state), day(job.createdAt), str(job.moveId)]),
    ...rows(record.copies).map((job) => ["copy", str(job.sourceName), str(job.state), day(job.createdAt), str(job.copyId)]),
  ];
  const lines = cells.length ? [...table(cells), "Cancel one: ade cloud jobs cancel <id>"] : ["ADE's server runs no launch, move or copy for you now."];
  for (const line of Array.isArray(record.unread) ? record.unread : []) lines.push(`Not read: ${String(line)}`);
  return lines.join("\n");
}

/** `ade cloud lanes git <lane>`: the Git summary the computer saved at rest. */
export function formatCloudLaneGit(value: unknown): string {
  const raw = resultOf(value);
  const lane = isRecord(raw) && isRecord(raw.lane) ? raw.lane : {};
  const summary = isRecord(raw) && isRecord(raw.summary) ? raw.summary : null;
  if (!summary) return `${str(lane.name)}: its computer saved no Git summary.`;
  const changed = rows(summary.changed);
  const lines = [
    `${str(lane.name)} · ${str(summary.branch) || "detached"}${str(summary.upstream) ? ` → ${str(summary.upstream)}` : ""}`,
    `${plural(Number(summary.ahead ?? 0), "commit")} ahead, ${Number(summary.behind ?? 0)} behind · ${summary.dirty === true ? "changes not committed" : "nothing to commit"} · saved ${day(summary.checkedAt ?? summary.updatedAt)}`,
  ];
  if (changed.length) lines.push("", ...table(changed.map((file) => [str(file.status), str(file.path), `+${Number(file.added ?? 0)} −${Number(file.removed ?? 0)}`])));
  if (summary.truncated === true) lines.push("  (more files changed)");
  return lines.join("\n");
}

/** `ade cloud project`: one project's whole ADE Cloud view. */
export function formatCloudProject(value: unknown): string {
  const raw = resultOf(value);
  if (!isRecord(raw)) return JSON.stringify(raw, null, 2);
  const lanes = rows(raw.lanes);
  const lines = [`${str(raw.origin)}: ${plural(lanes.length, "lane")}${raw.truncated === true ? " (more not shown)" : ""}`];
  lines.push(...table(lanes.map((lane) => {
    const computer = isRecord(lane.computer) ? lane.computer : null;
    const gone = isRecord(lane.withoutComputer);
    return [str(lane.laneName) || str(lane.laneId), str(lane.branch), gone ? "computer deleted" : computer ? str(computer.state) : "", str(lane.prState)];
  })));
  const chats = rows(raw.chats);
  const sessions = rows(raw.sessions);
  lines.push("", `${plural(chats.length, "saved chat")}${raw.nextChatCursor ? "+" : ""} · ${plural(sessions.length, "CLI or shell copy", "CLI or shell copies")}`);
  const soon = rows(raw.deletingSoon);
  if (soon.length) lines.push(`${plural(soon.length, "computer")} due for deletion: ${soon.map((entry) => day(entry.deletesAt)).join(", ")}`);
  return lines.join("\n");
}
