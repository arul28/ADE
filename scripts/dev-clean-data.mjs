#!/usr/bin/env node
// List the dev desktop's per-lane user-data folders and remove the stale ones.
//
//   npm run dev:clean-data                       list, remove nothing
//   npm run dev:clean-data -- --yes              remove stale marked folders
//   npm run dev:clean-data -- --yes --include-unmarked
//                                                also remove unmarked folders no
//                                                app is using
//
// `dev:desktop` already removes stale marked folders when it starts. This is
// for a look at what is there, and for folders made by hand before lanes got
// their own (those carry no marker, so nothing removes them on its own).

import fs from "node:fs";
import { listDevUserDataFolders, removeIfStillStale, userDataInUse } from "./dev-user-data.mjs";

const args = new Set(process.argv.slice(2));
if (args.has("-h") || args.has("--help")) {
  process.stdout.write("Usage: npm run dev:clean-data -- [--yes] [--include-unmarked]\n");
  process.exit(0);
}
for (const arg of args) {
  if (!["--yes", "--include-unmarked"].includes(arg)) {
    process.stderr.write(`Unknown option: ${arg}\n`);
    process.exit(2);
  }
}
const apply = args.has("--yes");
const includeUnmarked = args.has("--include-unmarked");

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "unknown");

const entries = listDevUserDataFolders({ withSize: true });
if (entries.length === 0) {
  process.stdout.write("No per-lane dev user-data folders.\n");
  process.exit(0);
}

let removable = 0;
let removed = 0;
let freed = 0;
for (const entry of entries) {
  const target = entry.stale || (includeUnmarked && !entry.marked && !entry.inUse);
  const state = entry.inUse
    ? "in use"
    : entry.stale
      ? `stale: ${entry.reason}`
      : entry.marked
        ? "kept"
        : "unmarked (made by hand)";
  let action = "";
  if (target) {
    removable += 1;
    if (apply) {
      // Ask again right before deleting: a dev app may have started on this
      // folder since the list was read.
      let ok = false;
      let why = "an app started using it";
      if (entry.marked) {
        ok = removeIfStillStale(entry.folder);
      } else if (!userDataInUse(entry.folder)) {
        try {
          fs.rmSync(entry.folder, { recursive: true, force: true });
          ok = true;
        } catch (error) {
          why = error instanceof Error ? error.message : String(error);
        }
      }
      if (ok) {
        removed += 1;
        freed += entry.bytes;
        action = "  -> removed";
      } else {
        action = `  -> not removed: ${why}`;
      }
    } else {
      action = "  -> would remove";
    }
  }
  process.stdout.write(
    `${entry.folder}\n    ${megabytes(entry.bytes)} · last used ${day(entry.lastUsedMs)} · ${state}${
      entry.worktreePath ? ` · ${entry.worktreePath}` : ""
    }${action}\n`,
  );
}

if (!apply) {
  process.stdout.write(
    removable
      ? `\n${removable} folder(s) would be removed. Run again with --yes to remove them.\n`
      : `\nNothing stale.${includeUnmarked ? "" : " Unmarked folders are kept unless you pass --include-unmarked."}\n`,
  );
} else {
  process.stdout.write(`\nRemoved ${removed} of ${removable} folder(s), ${megabytes(freed)}.\n`);
}
