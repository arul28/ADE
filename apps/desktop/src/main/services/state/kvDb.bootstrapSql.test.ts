import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildKvDbBootstrapSql } from "../../../../scripts/extractKvDbBootstrapSql.mjs";

const currentFile = fileURLToPath(import.meta.url);
const stateDir = path.dirname(currentFile);
const repoRoot = path.resolve(stateDir, "../../../../../../");
const iosBootstrapPath = path.join(repoRoot, "apps", "ios", "ADE", "Resources", "DatabaseBootstrap.sql");

describe("kvDb iOS bootstrap SQL", () => {
  it("matches the checked-in iOS bootstrap artifact", () => {
    const generated = buildKvDbBootstrapSql({ repoRoot });
    const checkedIn = fs.readFileSync(iosBootstrapPath, "utf8");
    expect(checkedIn).toBe(generated);
  });
});
