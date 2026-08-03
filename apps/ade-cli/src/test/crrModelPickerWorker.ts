import path from "node:path";
import { openKvDb } from "../../../desktop/src/main/services/state/kvDb";
import { createModelPickerStore } from "../services/modelPickerStore";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("Expected a database path.");

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

try {
  const db = await openKvDb(dbPath, logger);
  const crsqliteAvailable = db.sync.isAvailable?.() === true;
  if (!crsqliteAvailable) {
    throw new Error("CR-SQLite did not load in the native Windows worker.");
  }
  const store = createModelPickerStore({
    db,
    legacyFilePath: path.join(path.dirname(dbPath), "missing-model-picker.json"),
  });
  store.toggleFavorite("gpt-5");
  store.pushRecent("claude-sonnet-5");
  process.stdout.write(JSON.stringify({
    crsqliteAvailable,
    favorites: store.getFavorites(),
    recents: store.getRecents(),
  }));
  // A Windows brain owns the native extension for its process lifetime. Exit
  // the isolated worker so the OS unloads the DLL before the parent removes
  // the fixture directory; closing a CRR-rich connection can block in the
  // upstream Windows extension teardown path.
  process.exit(0);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
