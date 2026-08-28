import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crsqliteExtensionFileName, currentTarget } from "./package-native-deps.mjs";

const probeScriptPath = fileURLToPath(import.meta.url);
const LOCAL_ARCHIVE_NAME = "archive.tar.gz";

function spawnHidden(command, args, options = {}) {
  return spawnSync(command, args, { ...options, windowsHide: true });
}

function parseArgs(argv) {
  const args = { archive: null, extension: null, target: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--archive") {
      args.archive = argv[++i] ?? null;
    } else if (token === "--extension") {
      args.extension = argv[++i] ?? null;
    } else if (token === "--target") {
      args.target = argv[++i] ?? null;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function expectedArchiveEntries(target) {
  const fileName = crsqliteExtensionFileName(target);
  return [
    `./vendor/crsqlite/${target}/${fileName}`,
    `vendor/crsqlite/${target}/${fileName}`,
  ];
}

function tarListArgs() {
  return ["-tzf", LOCAL_ARCHIVE_NAME];
}

function tarExtractArgs(entry) {
  return ["-xzf", LOCAL_ARCHIVE_NAME, entry];
}

function runTar(args, cwd) {
  const result = spawnHidden("tar", args, { encoding: "utf8", cwd });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `tar ${args.join(" ")} failed`).trim());
  }
  return result;
}

function probe(extensionPath) {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  try {
    db.enableLoadExtension(true);
    db.loadExtension(extensionPath);
    db.exec("create table ade_packaged_crr_probe (id text primary key not null, value text)");
    db.prepare("select crsql_as_crr(?)").get("ade_packaged_crr_probe");
    db.prepare("insert into ade_packaged_crr_probe (id, value) values (?, ?)").run("probe", "ready");
    const row = db.prepare(
      "select count(*) as count from crsql_changes where [table] = ?",
    ).get("ade_packaged_crr_probe");
    const changeRows = Number(row?.count ?? 0);
    if (changeRows < 1) {
      throw new Error("CR-SQLite loaded but did not record the runtime probe change.");
    }
    return changeRows;
  } finally {
    db.close();
  }
}

function isWindowsDeleteLockError(error) {
  return process.platform === "win32"
    && error
    && ["EPERM", "EACCES", "EBUSY"].includes(error.code);
}

function stageArchive(archive) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ade-crsqlite-probe-"));
  // GNU tar treats `D:` / `C:` as a remote host. Copy with Node, then invoke
  // tar with a relative name from this directory — never a Windows absolute path.
  fs.copyFileSync(path.resolve(archive), path.join(tmp, LOCAL_ARCHIVE_NAME));
  return {
    tmp,
    cleanup() {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (error) {
        if (isWindowsDeleteLockError(error)) return;
        throw error;
      }
    },
  };
}

function listStagedArchive(tmp) {
  return runTar(tarListArgs(), tmp).stdout.split(/\r?\n/).filter(Boolean);
}

function extractStagedEntry(tmp, entry) {
  runTar(tarExtractArgs(entry), tmp);
  return path.join(tmp, ...entry.replace(/^\.\//, "").split("/"));
}

function extractExtension(archive, entry) {
  const staged = stageArchive(archive);
  try {
    const filePath = extractStagedEntry(staged.tmp, entry);
    return {
      filePath,
      cleanup: staged.cleanup,
    };
  } catch (error) {
    staged.cleanup();
    throw error;
  }
}

function probeExtractedExtension(extensionPath) {
  // Load in a child so Windows can delete the extracted DLL after the child
  // exits. sqlite3_load_extension keeps the module mapped until process exit;
  // DatabaseSync.close() does not FreeLibrary.
  const result = spawnHidden(process.execPath, [probeScriptPath, "--extension", extensionPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "cr-sqlite extension probe failed").trim());
  }
  process.stdout.write(result.stdout);
}

function probeArchive(archive, target) {
  const staged = stageArchive(archive);
  try {
    const listing = listStagedArchive(staged.tmp);
    const found = expectedArchiveEntries(target).find((entry) => listing.includes(entry));
    if (!found) {
      throw new Error(
        `Native archive ${path.resolve(archive)} is missing cr-sqlite for ${target} ` +
          `(looked for ${expectedArchiveEntries(target).join(" or ")}).`,
      );
    }
    process.stdout.write(`[probe-runtime-crsqlite] archive contains ${found}\n`);
    if (currentTarget() !== target) {
      process.stdout.write(
        `[probe-runtime-crsqlite] skipped live load (host ${currentTarget()}, target ${target})\n`,
      );
      return;
    }
    probeExtractedExtension(extractStagedEntry(staged.tmp, found));
  } finally {
    staged.cleanup();
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.archive && !args.extension) {
    throw new Error("Pass --archive <native.tar.gz> --target <target> and/or --extension <path>.");
  }
  if (args.archive) {
    if (!args.target) {
      throw new Error("--archive requires --target.");
    }
    probeArchive(args.archive, args.target);
  }
  if (args.extension) {
    const changeRows = probe(args.extension);
    process.stdout.write(
      `[probe-runtime-crsqlite] loaded ${args.extension} and recorded ${changeRows} CRR change(s)\n`,
    );
  }
}

export {
  expectedArchiveEntries,
  extractExtension,
  LOCAL_ARCHIVE_NAME,
  tarExtractArgs,
  tarListArgs,
};

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[probe-runtime-crsqlite] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
