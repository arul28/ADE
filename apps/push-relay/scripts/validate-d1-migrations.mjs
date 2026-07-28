import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unstable_splitSqlQuery } from "wrangler";

const migrationsDirectory = path.join(import.meta.dirname, "..", "migrations");
const migrationNames = fs
  .readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const database = new DatabaseSync(":memory:");

try {
  for (const migrationName of migrationNames) {
    const sql = fs.readFileSync(
      path.join(migrationsDirectory, migrationName),
      "utf8",
    );
    const statements = unstable_splitSqlQuery(sql);

    for (const statement of statements) {
      const triggerCount =
        statement.match(/\bcreate\s+trigger\b/giu)?.length ?? 0;

      if (triggerCount > 1) {
        throw new Error(
          `${migrationName} contains multiple triggers in one Wrangler query`,
        );
      }

      if (triggerCount === 1 && !/\bEND\s*$/u.test(statement.trim())) {
        throw new Error(
          `${migrationName} contains a trigger Wrangler cannot split safely for D1 migration execution`,
        );
      }

      database.exec(statement);
    }
  }

  const triggerCount = database
    .prepare(
      "select count(*) as count from sqlite_master where type = 'trigger'",
    )
    .get().count;

  if (triggerCount !== 2) {
    throw new Error(
      `Expected 2 D1 triggers after migrations, found ${triggerCount}`,
    );
  }

  console.log(
    `Validated ${migrationNames.length} D1 migrations with Wrangler's query splitter`,
  );
} finally {
  database.close();
}
