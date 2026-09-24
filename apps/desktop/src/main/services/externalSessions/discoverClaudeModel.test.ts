import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { discoverClaudeSessions } from "./discoverClaude";
import { claudeProjectSlugForCwd } from "./discoveryUtils";

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-model-"))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it("records the newest assistant model so a continue keeps it", () => {
  // 2026-09-23: a Haiku session continued as an ADE chat on the default Opus.
  const home = path.join(root, "home");
  const cwd = path.join(root, "lane");
  fs.mkdirSync(cwd, { recursive: true });
  const id = "11111111-2222-4333-8444-555555555555";
  const file = path.join(home, ".claude", "projects", claudeProjectSlugForCwd(cwd), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [
    { type: "user", sessionId: id, cwd, timestamp: "2026-09-23T10:00:00.000Z", message: { role: "user", content: "hi" } },
    { type: "assistant", sessionId: id, cwd, timestamp: "2026-09-23T10:00:01.000Z", message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "hello" }] } },
    { type: "assistant", sessionId: id, cwd, timestamp: "2026-09-23T10:00:02.000Z", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "limit" }] } },
  ];
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return discoverClaudeSessions({ homeDir: home, limit: 5 }).then(([session]) => {
    expect(session?.launch).toEqual({ model: "claude-haiku-4-5-20251001" });
  });
});
