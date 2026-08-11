// ade-log-viewer — .log and .ndjson in the Files tab.
//
// The data path, stated plainly, because a viewer that pretends to have bytes
// it does not have is the failure mode worth designing against:
//
//   1. The Files tab opens a file, sees this plugin's `file-viewer` socket
//      claims the extension, and mounts the `viewer` panel with the file's
//      identity attached — `{workspaceId, path, size, extension}`. Not its
//      bytes: a panel schema is capped at 64 KiB and is data, not a buffer.
//   2. Pressing Load dispatches the `load` action below WITH that identity.
//   3. This process reads the END of the file through the host's own file
//      action (`file.readFileRange`), which is allowlisted for plugins and
//      applies the same workspace jail every other reader gets. The plugin
//      never touches the filesystem directly — a workspace id is not a path,
//      and resolving one itself would be inventing a second jail.
//   4. It parses the slice here, on the machine that holds the file, and
//      publishes the result as a panel. Rows cross the wire; the file does not.
//
// One consequence worth knowing: a panel is identified by (plugin, panelId), so
// two log files open at once share one `viewer` panel and the last Load wins.
// The panel names the file it read, so this is visible rather than confusing.

"use strict";

const {
  buildPromptSchema,
  buildViewerSchema,
  clampInt,
  parseLogLines,
  summarize,
} = require("./logParse");

/** Bytes read from the end of the file. Two orders of magnitude under the range cap. */
const READ_BYTES = 128 * 1024;

/** Attempts to publish the prompt panel before giving up until the next restart. */
const PUBLISH_ATTEMPTS = 5;
const PUBLISH_RETRY_MS = 3_000;

let sdk = null;

function fileContextOf(args) {
  const context = args && args.context;
  if (!context || typeof context !== "object") return null;
  if (context.kind !== "file") return null;
  const workspaceId = typeof context.workspaceId === "string" ? context.workspaceId : "";
  const filePath = typeof context.path === "string" ? context.path : "";
  if (!workspaceId || !filePath) return null;
  const size = typeof context.size === "number" && Number.isFinite(context.size) ? context.size : 0;
  return { workspaceId, path: filePath, size };
}

function baseName(filePath) {
  const parts = String(filePath).split("/");
  return parts[parts.length - 1] || filePath;
}

/**
 * Publish, retrying while the host has no project attached.
 *
 * Panel writes are project-scoped and the plugin host is machine-scoped, so at
 * cold start this can run before any project is open. Letting that throw out of
 * `activate` would read as a crash and start the restart backoff.
 */
async function publish(panelId, schema, attempt = 1) {
  try {
    await sdk.panels.update(panelId, schema);
    return true;
  } catch (error) {
    if (attempt >= PUBLISH_ATTEMPTS) {
      sdk.log("warn", `Could not publish the ${panelId} panel: ${message(error)}`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_MS));
    return publish(panelId, schema, attempt + 1);
  }
}

function message(error) {
  return error && error.message ? error.message : String(error);
}

exports.activate = async (ade) => {
  sdk = ade;
  await publish("viewer", buildPromptSchema());
};

exports.deactivate = async () => {
  sdk = null;
};

exports.actions = {
  /**
   * Read the tail of the file the viewer is showing and publish it.
   *
   * `args.context` is the file, supplied by the host. `args.level` comes from
   * the panel's own filter, so pressing Reload with a level selected re-reads
   * and re-filters in one step.
   */
  async load(args) {
    const file = fileContextOf(args);
    if (!file) {
      await publish("viewer", buildPromptSchema(
        "This panel is showing outside a file, so there is nothing to read. Open a .log or .ndjson file in Files.",
      ));
      return { loaded: false, reason: "no_file_context" };
    }

    const config = await sdk.config.get();
    const limit = clampInt(config.tailLines, 10, 100, 100);
    const offset = file.size > READ_BYTES ? file.size - READ_BYTES : 0;

    let page;
    try {
      page = await sdk.actions.invoke("file", "readFileRange", {
        workspaceId: file.workspaceId,
        path: file.path,
        offset,
        length: READ_BYTES,
      });
    } catch (error) {
      await publish("viewer", buildPromptSchema(`This file could not be read: ${message(error)}`));
      return { loaded: false, reason: "read_failed" };
    }

    if (!page || page.encoding !== "utf-8") {
      await publish("viewer", buildPromptSchema(
        "This file is not UTF-8 text, so there are no log lines to show.",
      ));
      return { loaded: false, reason: "not_text" };
    }

    const truncated = offset > 0;
    const entries = parseLogLines(page.content, truncated);
    const counts = summarize(entries);
    const level = typeof args.level === "string" ? args.level : "all";

    await publish("viewer", buildViewerSchema({
      fileName: baseName(file.path),
      filePath: file.path,
      totalSize: typeof page.totalSize === "number" ? page.totalSize : file.size,
      readBytes: READ_BYTES,
      truncated,
      entries,
      counts,
      level,
      limit,
    }));

    return { loaded: true, lines: entries.length, errors: counts.error, warnings: counts.warn };
  },
};
