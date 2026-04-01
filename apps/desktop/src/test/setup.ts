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

// nwsapi (jsdom's CSS selector engine) throws on Tailwind arbitrary-value
// class names like `rounded-[8px]` because `[` opens an attribute selector.
// Patch querySelector/querySelectorAll to swallow the SYNTAX_ERR (code 12)
// so @testing-library queries that walk the DOM don't crash.
if (typeof Element !== "undefined") {
  const origQS = Element.prototype.querySelector;
  Element.prototype.querySelector = function (selectors: string) {
    try {
      return origQS.call(this, selectors);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.code === 12 /* SYNTAX_ERR */) return null;
      throw err;
    }
  };
  const origQSA = Element.prototype.querySelectorAll;
  Element.prototype.querySelectorAll = function (selectors: string) {
    try {
      return origQSA.call(this, selectors);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.code === 12 /* SYNTAX_ERR */) {
        return document.createDocumentFragment().querySelectorAll("*");
      }
      throw err;
    }
  };
}
