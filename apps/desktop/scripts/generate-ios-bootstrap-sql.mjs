import fs from "node:fs";
import path from "node:path";
import { buildKvDbBootstrapSql } from "./extractKvDbBootstrapSql.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const outputPath = path.join(repoRoot, "apps", "ios", "ADE", "Resources", "DatabaseBootstrap.sql");

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, buildKvDbBootstrapSql({ repoRoot }), "utf8");
process.stdout.write(`${outputPath}\n`);
