import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverCursorSessions } from "./discoverCursor";

/**
 * Mirrors `cursorProjectSlugForCwd` in discoverCursor.ts. A Windows drive
 * prefix has to be dropped rather than hyphenated, because `C:-Users-…`
 * contains a colon and can therefore never be a real directory name.
 */
function cursorProjectSlug(cwd: string): string {
  return cwd
    .replace(/^([A-Za-z]):[\\/]+/u, "")
    .replace(/^[/\\]+/u, "")
    .replace(/[\\/]/gu, "-");
}

function writeTranscript(home: string, slug: string, agentId: string, cwd: string): void {
  const dir = path.join(home, ".cursor", "projects", slug, "agent-transcripts", agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${agentId}.jsonl`),
    `${JSON.stringify({
      type: "user",
      timestamp: 1_700_000_000_000,
      cwd,
      message: { role: "user", content: "hello" },
    })}\n`,
  );
}

describe("discoverCursorSessions", () => {
  it("imports a transcript for an existing scoped workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-import-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "repo");
    fs.mkdirSync(workspace, { recursive: true });
    writeTranscript(home, cursorProjectSlug(workspace), "chat-existing", workspace);

    try {
      const records = await discoverCursorSessions({ homeDir: home, scopeRoots: [workspace], limit: 10 });
      expect(records.map((record) => record.id)).toContain("chat-existing");
      expect(records[0]?.cwd).toBe(workspace);
      expect(records[0]?.preview).toBe("hello");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a transcript in scope when its workspace directory no longer exists", async () => {
    // Without the drive-prefix fix this drops the session on Windows: the
    // slug-to-cwd resolver cannot help once the directory is gone, so the
    // structural slug comparison is the only thing left, and it can never
    // match a slug containing `C:`. macOS has no drive prefix and passes.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-import-gone-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "deleted-repo");
    writeTranscript(home, cursorProjectSlug(workspace), "chat-deleted", workspace);

    try {
      const records = await discoverCursorSessions({ homeDir: home, scopeRoots: [workspace], limit: 10 });
      expect(records.map((record) => record.id)).toContain("chat-deleted");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
