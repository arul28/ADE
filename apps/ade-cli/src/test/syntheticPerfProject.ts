// Seeded ADE project at realistic scale, shared by the network benches
// (scripts/perf/net/make-synthetic-project.mts) and the phone wire-budget test
// (services/sync/syncWireBudget.test.ts). Same seed, same rows, ids and transcript bytes; nothing is
// read from ~/.ade or any real project.
//
// Default shape (sized from a heavy user's project):
//   - a git repo with one commit, a project icon (icon.png), 20 lanes as real git worktrees;
//   - 1,000 chats: 60% ended old chats, 25% idle subagent children (spawnKind "subagent", parent in
//     the same lane), 12% idle chats, 3% recent chats; Claude / Codex / OpenCode mix;
//   - per-chat metadata files (lognormal size, p50 ~4.5 KB) and short transcripts (1-6 turns);
//   - one big chat: 1,000 turns with streamed text and tool output (~10 MB of transcript), the newest
//     chat in the project.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { resolveAdeLayout } from "../../../desktop/src/shared/adeLayout";
import { createSessionService } from "../../../desktop/src/main/services/sessions/sessionService";
import { openKvDb } from "../../../desktop/src/main/services/state/kvDb";

export type SyntheticPerfProject = {
  projectRoot: string;
  projectId: string;
  bigChatId: string | null;
  bigChatTranscriptMB: number;
  chats: number;
  kinds: Record<string, number>;
  lanes: number;
  transcriptMB: number;
  iconBytes: number;
};

export async function buildSyntheticPerfProject(
  rootPath: string,
  options: { chats?: number; lanes?: number; bigTurns?: number } = {},
): Promise<SyntheticPerfProject> {
  const root = path.resolve(rootPath);
  const CHATS = options.chats ?? 1000;
  const LANES = Math.max(1, options.lanes ?? 20);
  const BIG_TURNS = options.bigTurns ?? 1000;
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) throw new Error(`${root} is not empty`);
  const T0 = Date.parse("2026-10-20T12:00:00.000Z");
  const MINUTE = 60_000;
  let seed = 1337;
  function random(): number {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join("");
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
  const WORDS = "the module change lane chat renders list sync phone roster snapshot replica cursor batch ack pump reconnect bytes frame deflate compress budget ceiling measure profile proxy latency bandwidth handshake hello project catalog icon worktree branch commit rebase conflict status".split(" ");
  const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");

  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull } });

  fs.mkdirSync(root, { recursive: true });
  git(["init", "-q", "-b", "main"], root);
  fs.writeFileSync(path.join(root, "README.md"), "# Synthetic ADE perf project\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  for (let i = 0; i < 40; i += 1) fs.writeFileSync(path.join(root, "src", `file-${i}.ts`), `export const value${i} = ${i};\n${"// filler\n".repeat(50)}`);
  // A 128x128 PNG icon (a solid square; size, not art, is what the wire pays for).
  fs.writeFileSync(path.join(root, "icon.png"), makePng(128, 128));
  git(["add", "."], root);
  git(["-c", "user.email=perf@ade.invalid", "-c", "user.name=ADE perf", "commit", "-qm", "initial"], root);

  const layout = resolveAdeLayout(root);
  fs.mkdirSync(layout.chatSessionsDir, { recursive: true });
  fs.mkdirSync(layout.chatTranscriptsDir, { recursive: true });
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
  const db = await openKvDb(path.join(root, ".ade", "ade.db"), silentLogger as never);
  const projectId = `project-perf-${hex(8)}`;
  const now = new Date(T0).toISOString();
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [projectId, root, path.basename(root), "main", now, now],
  );

  const laneIds: string[] = [];
  for (let index = 0; index < LANES; index += 1) {
    const laneId = `lane-${uuid()}`;
    const name = index === 0 ? "Primary" : `feature-${index}`;
    const branch = index === 0 ? "main" : `perf/feature-${index}`;
    const worktree = index === 0 ? root : path.join(root, ".ade", "worktrees", `feature-${index}`);
    if (index > 0) git(["worktree", "add", "-q", "-b", branch, worktree, "main"], root);
    db.run(
      `insert into lanes(id, project_id, name, lane_type, base_ref, branch_ref, worktree_path, is_edit_protected, status, created_at)
       values (?, ?, ?, ?, 'main', ?, ?, 0, 'active', ?)`,
      [laneId, projectId, name, index === 0 ? "primary" : "worktree", branch, worktree, new Date(T0 - (LANES - index) * 60 * MINUTE).toISOString()],
    );
    laneIds.push(laneId);
  }
  // Lane skew: the first few lanes hold most chats.
  const pickLane = () => laneIds[Math.min(laneIds.length - 1, Math.floor(Math.abs(gauss()) * laneIds.length / 3))]!;

  const sessionService = createSessionService({ db, logger: silentLogger as never });
  const TOOLS = [
    { toolType: "claude-chat", provider: "claude", model: "sonnet" },
    { toolType: "claude-chat", provider: "claude", model: "opus" },
    { toolType: "codex-chat", provider: "codex", model: "gpt-5-codex" },
    { toolType: "opencode-chat", provider: "opencode", model: "opencode/anthropic/claude-sonnet-5" },
  ] as const;

  type Kind = "big" | "recent" | "idle" | "subagent" | "ended";
  const kinds: Kind[] = [];
  if (BIG_TURNS > 0) kinds.push("big");
  const rest = Math.max(0, CHATS - kinds.length);
  const quota: Array<[Kind, number]> = [["recent", 0.03], ["idle", 0.12], ["subagent", 0.25], ["ended", 0.6]];
  for (const [kind, share] of quota) for (let i = 0; i < Math.round(rest * share); i += 1) kinds.push(kind);
  while (kinds.length < CHATS) kinds.push("ended");
  kinds.length = CHATS;

  function writeTranscript(sessionId: string, laneId: string, provider: string, model: string, startMs: number, turns: number, big: boolean): number {
    const lines: string[] = [JSON.stringify({ type: "session_init", sessionId, laneId, provider, model, createdAt: new Date(startMs).toISOString() })];
    let sequence = 0;
    const push = (event: Record<string, unknown>) => {
      sequence += 1;
      lines.push(JSON.stringify({ sessionId, timestamp: new Date(startMs + sequence * 400).toISOString(), event, sequence }));
    };
    for (let turn = 0; turn < turns; turn += 1) {
      const turnId = `turn-${uuid()}`;
      const messageId = `msg-${uuid()}`;
      push({ type: "user_message", text: `Turn ${turn}: ${sentence(18)}`, turnId, messageId });
      push({ type: "status", turnStatus: "started", turnId });
      const deltas = big ? 12 : 4 + Math.floor(random() * 8);
      for (let delta = 0; delta < deltas; delta += 1) push({ type: "text", text: `${sentence(10)} `, turnId, messageId: `asst-${messageId}`, itemId: `item-${turnId}` });
      const tools = big ? 3 : Math.floor(random() * 4);
      for (let tool = 0; tool < tools; tool += 1) {
        const itemId = `tool-${uuid()}`;
        const name = pick(["Read", "Bash", "Grep", "Edit"]);
        push({ type: "tool_call", tool: name, args: { path: `src/file-${Math.floor(random() * 40)}.ts`, command: name === "Bash" ? "npm test -- --run" : undefined }, itemId, turnId });
        push({ type: "tool_result", tool: name, result: `${sentence(8)}\n`.repeat(big ? 16 : 10), itemId, turnId, status: "completed" });
      }
      push({ type: "context_usage", turnId, inputTokens: 1000 + turn * 50, outputTokens: 300 });
      push({ type: "done", turnId, status: "completed" });
    }
    const file = path.join(layout.chatTranscriptsDir, `${sessionId}.jsonl`);
    const body = `${lines.join("\n")}\n`;
    fs.writeFileSync(file, body);
    return Buffer.byteLength(body);
  }

  let transcriptBytes = 0;
  let bigChatId: string | null = null;
  let bigChatBytes = 0;
  const parentsByLane = new Map<string, string[]>();
  const counts: Record<Kind, number> = { big: 0, recent: 0, idle: 0, subagent: 0, ended: 0 };
  // Parents first (non-subagent chats), so subagent children can name one in their lane.
  const order = kinds.map((kind, index) => ({ kind, index })).sort((a, b) => Number(a.kind === "subagent") - Number(b.kind === "subagent"));
  for (const { kind, index } of order) {
    counts[kind] += 1;
    const id = uuid();
    const tool = pick(TOOLS);
    let laneId = pickLane();
    const ageMinutes = kind === "big" ? 1 : kind === "recent" ? 5 + index : kind === "idle" ? 120 + index * 7 : kind === "subagent" ? 60 + index * 11 : 3_000 + index * 37;
    const startMs = T0 - ageMinutes * MINUTE;
    let parent: string | null = null;
    if (kind === "subagent") {
      const lanesWithParents = [...parentsByLane.keys()];
      laneId = lanesWithParents.length ? pick(lanesWithParents) : laneId;
      parent = pick(parentsByLane.get(laneId) ?? [null as never]) ?? null;
    } else {
      parentsByLane.set(laneId, [...(parentsByLane.get(laneId) ?? []), id]);
    }
    const turns = kind === "big" ? BIG_TURNS : 1 + Math.floor(random() * 6);
    const bytes = writeTranscript(id, laneId, tool.provider, tool.model, startMs, turns, kind === "big");
    transcriptBytes += bytes;
    if (kind === "big") { bigChatId = id; bigChatBytes = bytes; }
    const title = kind === "big" ? "Big chat: 1,000 turns" : `${kind} chat ${index}: ${sentence(4)}`;
    sessionService.create({
      sessionId: id,
      laneId,
      ptyId: null,
      tracked: true,
      title,
      startedAt: new Date(startMs).toISOString(),
      transcriptPath: path.join(layout.chatTranscriptsDir, `${id}.jsonl`),
      toolType: tool.toolType as never,
      chatSessionId: null,
    });
    const endedAt = new Date(startMs + Math.max(1, turns) * 2 * MINUTE).toISOString();
    if (kind === "ended") {
      db.run("update terminal_sessions set status = 'completed', ended_at = ?, exit_code = 0 where id = ?", [endedAt, id]);
    }
    const metadataTarget = Math.min(152_000, Math.max(400, Math.round(Math.exp(Math.log(4_500) + 1.554 * gauss()))));
    const state = {
      version: 2,
      sessionId: id,
      laneId,
      provider: tool.provider,
      model: tool.model,
      title,
      updatedAt: kind === "ended" ? endedAt : new Date(startMs + MINUTE).toISOString(),
      ...(parent ? { orchestrationParentSessionId: parent, spawnKind: "subagent" } : {}),
      padding: "x".repeat(Math.max(0, metadataTarget - 400)),
    };
    fs.writeFileSync(path.join(layout.chatSessionsDir, `${id}.json`), JSON.stringify(state));
  }

  db.flushNow?.();
  await db.close?.();
  const fixture = {
    projectRoot: root,
    projectId,
    bigChatId,
    bigChatTranscriptMB: +(bigChatBytes / 1e6).toFixed(2),
    chats: CHATS,
    kinds: counts,
    lanes: LANES,
    transcriptMB: +(transcriptBytes / 1e6).toFixed(2),
    iconBytes: fs.statSync(path.join(root, "icon.png")).size,
  };
  fs.writeFileSync(path.join(root, "fixture.json"), `${JSON.stringify(fixture, null, 2)}\n`);
  return fixture;
}

/** A valid RGBA PNG, uncompressed-ish (deflate level 0) so its size is predictable. */
function makePng(width: number, height: number): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = (buf: Buffer) => {
    let c = -1;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4;
      raw[at] = (x * 2) & 0xff; raw[at + 1] = (y * 2) & 0xff; raw[at + 2] = ((x ^ y) * 3) & 0xff; raw[at + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
