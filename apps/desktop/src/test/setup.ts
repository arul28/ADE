import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const claudeConfigDir = path.join(os.tmpdir(), "ade-vitest-claude-config");

fs.mkdirSync(path.join(claudeConfigDir, "debug"), { recursive: true });

process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

// jsdom doesn't implement scrollTo on elements; stub it globally for tests.
if (typeof Element !== "undefined" && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}
