import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openKvDb, type AdeDb } from "../main/services/state/kvDb";

type OpenArgs = Parameters<typeof openKvDb>;

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as OpenArgs[1];

let template: Promise<string> | null = null;

/** A database with every migration and CRR conversion already applied, made once per test file. */
async function migratedTemplate(): Promise<string> {
  const cached = template ? await template : null;
  // The setup file deletes `ade-` temp folders after each file; build again if that ran.
  if (cached && fs.existsSync(cached)) return cached;
  template = (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-template-"));
    const file = path.join(dir, "template.sqlite");
    const db = await openKvDb(file, silentLogger);
    db.close();
    return file;
  })();
  return template;
}

/**
 * `openKvDb` for a test that needs a new, empty project database.
 *
 * A first open runs every migration and converts every table for sync, about
 * 300 ms. Here that runs once per test file; each later new database starts
 * as a copy of it and opens the way an existing project database does (about
 * 10 ms), with its own site id. A path that already exists, or an open with
 * options, goes straight to `openKvDb`, so reopen and upgrade tests see the
 * real path. Tests of the open itself (kvDb, sync) use `openKvDb` directly.
 */
export async function openFreshKvDb(dbPath: OpenArgs[0], logger: OpenArgs[1], options?: OpenArgs[2]): Promise<AdeDb> {
  if (options === undefined && !fs.existsSync(dbPath)) {
    const source = await migratedTemplate();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.copyFileSync(source, dbPath);
  }
  return openKvDb(dbPath, logger, options);
}
