import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkFiles, findNulBytes } from "./check-source-nul-bytes.mjs";

test("findNulBytes reports each literal NUL with its 1-based line and column", () => {
  assert.deepEqual(findNulBytes(Buffer.from("ab\u0000cd")), [{ line: 1, column: 3 }]);
  assert.deepEqual(findNulBytes(Buffer.from("ab\ncd\u0000e")), [{ line: 2, column: 3 }]);
  assert.deepEqual(findNulBytes(Buffer.from("two\u0000nul\u0000s")), [
    { line: 1, column: 4 },
    { line: 1, column: 8 },
  ]);
  assert.deepEqual(findNulBytes(Buffer.from("clean source\n")), []);
});

test("checkFiles flags source files but ignores other extensions and missing paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ade-nul-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "bad.ts"), Buffer.from("const a = 1;\u0000\n"));
  await fs.writeFile(path.join(root, "src", "art.png"), Buffer.from([0x00, 0x01]));
  await fs.writeFile(path.join(root, "src", "note.txt"), Buffer.from("x\u0000y"));

  const violations = checkFiles(root, ["src/bad.ts", "src/art.png", "src/note.txt", "src/missing.ts"]);

  assert.deepEqual(violations, [{ file: "src/bad.ts", line: 1, column: 13 }]);
});

test("checkFiles reports the line of a NUL that is not on the first line", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ade-nul-"));
  await fs.writeFile(path.join(root, "bad.md"), Buffer.from("line one\nline\u0000two\n"));

  assert.deepEqual(checkFiles(root, ["bad.md"]), [{ file: "bad.md", line: 2, column: 5 }]);
});
