import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { PROJECT_NOTES_LIMITS } from "../../../shared/types/projectNotes";
import { createProjectNotesService } from "./projectNotesService";

/**
 * Project notes go into every new agent prompt, are written by agents, and
 * replicate to every machine with the project. What must hold: a machine note
 * reaches only its own machine's agents, and no write or sync can grow the
 * block past its cap.
 */
const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

describe("project notes", () => {
  let dir: string;
  let db: AdeDb;
  let ids = 0;
  // Two machines on one replicated table, as sync leaves them.
  const machine = (key: string) =>
    createProjectNotesService({ db, getLocalMachineKey: () => key, newId: () => `note${String(ids++).padStart(6, "0")}` });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-notes-"));
    db = await openKvDb(path.join(dir, "ade.db"), logger);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives a machine note only to that machine's agents, and lets no other machine change it", () => {
    const laptop = machine("laptop");
    const studio = machine("studio");
    laptop.add({ section: "iOS", body: "Use the iPhone 17 simulator", scope: "project" });
    const local = laptop.add({ section: "iOS", body: "Xcode lives in /Applications/Xcode-beta.app", scope: "machine" });

    expect(laptop.renderPromptBlock()).toContain("Xcode-beta");
    expect(studio.renderPromptBlock()).toContain("iPhone 17 simulator");
    expect(studio.renderPromptBlock()).not.toContain("Xcode-beta");
    expect(studio.list().notes.map((note) => note.body)).toEqual(["Use the iPhone 17 simulator"]);
    expect(() => studio.edit({ id: local.id, body: "changed" })).toThrow(/No project note/);
    expect(() => studio.remove({ id: local.id })).toThrow(/No project note/);
  });

  it.each([
    ["a note longer than one line allows", { section: "iOS", body: "x".repeat(PROJECT_NOTES_LIMITS.maxNoteChars + 1) }, /limit is 200/],
    ["a section name that is too long", { section: "s".repeat(PROJECT_NOTES_LIMITS.maxSectionChars + 1), body: "fact" }, /at most 32/],
    ["a note past the per-section count", { section: "iOS", body: "one too many" }, /already has 8 of 8/, 8],
  ])("refuses %s and writes nothing", (_label, input, message, seeded = 0) => {
    const service = machine("laptop");
    for (let index = 0; index < seeded; index += 1) service.add({ section: "iOS", body: `fact ${index}` });
    expect(() => service.add(input)).toThrow(message);
    expect(service.list().notes).toHaveLength(seeded);
  });

  it("refuses a write that would push the block past its byte cap", () => {
    const service = machine("laptop");
    const body = "y".repeat(PROJECT_NOTES_LIMITS.maxNoteChars);
    let saved = 0;
    expect(() => {
      for (let section = 0; section < 40; section += 1) {
        service.add({ section: `area ${section}`, body });
        saved += 1;
      }
    }).toThrow(/Project notes are full/);
    expect(service.list().notes).toHaveLength(saved);
    expect(Buffer.byteLength(service.renderPromptBlock(), "utf8")).toBeLessThanOrEqual(PROJECT_NOTES_LIMITS.maxRenderedBytes);
  });

  it("keeps the block under its cap when synced rows exceed it, and says notes were left out", () => {
    // Rows that arrive by sync skip the write checks; rendering is the last guard.
    for (let index = 0; index < 40; index += 1) {
      db.run(
        `insert into project_agent_notes (id, scope, machine_id, section, body, created_at, updated_at, updated_by)
         values (?, 'project', null, ?, ?, ?, ?, null)`,
        [`synced${index}`, `area ${index}`, "z".repeat(PROJECT_NOTES_LIMITS.maxNoteChars), "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
      );
    }
    const block = machine("laptop").renderPromptBlock();
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(PROJECT_NOTES_LIMITS.maxRenderedBytes);
    expect(block).toMatch(/more notes? left out/);
  });
});
