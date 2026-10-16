import { SceneDrawingBox } from "./SceneDrawingBox";

/**
 * The scene an agent is drafting with `ade scene preview`, held at the bottom
 * of the active turn while it works: the same "drawing" box a scene shows
 * while its fence arrives, with the agent's new output streaming in above it.
 * It goes when the reply starts writing the scene itself, whose own box takes
 * over in place (see `WorkingIndicator`), or when the turn ends.
 *
 * Never the preview's screenshot. A still of a scene in the transcript read
 * as the scene itself, frozen: it could not be dragged, hovered or played,
 * and an agent that previews eight times stamped eight of them. The live
 * scene arrives in the reply.
 */

// The preview tool writes `<project>/.ade/cache/scene-previews/scene-<stamp>.png`.
// Either separator (Windows), and spaces (`C:\Users\Jane Doe\…`); a line
// break or a quote ends a path.
const PREVIEW_PATH = /((?:[A-Za-z]:)?[\\/][^\r\n"'<>|]*?[\\/]\.ade[\\/]cache[\\/]scene-previews[\\/]scene-[\w.-]+\.png)/;

const JSON_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

/**
 * A tool result arrives JSON-encoded (`{"output":"ok\nscreenshot  …"}`), where
 * a newline is the two characters `\n` and a path separator is `\\`. Decode
 * those first, or the path would seem to start at the escaped newline. Plain
 * command output is left alone: a Windows path in it may contain `\n` for real.
 */
function decodeIfJson(text: string): string {
  const head = text.trimStart()[0];
  if (head !== "{" && head !== "[" && head !== '"') return text;
  return text.replace(/\\(["\\/bfnrt])/g, (_match, char: string) => JSON_ESCAPES[char] ?? char);
}

/** True when `path` is a screenshot `ade scene preview` wrote. */
export function isScenePreviewImagePath(path: string | null | undefined): boolean {
  return Boolean(path) && PREVIEW_PATH.test(path!);
}

/** The preview PNG an `ade scene preview` output names, if any. */
export function readScenePreviewPath(output: string | null | undefined): string | null {
  if (!output || !output.includes("scene-previews")) return null;
  const match = PREVIEW_PATH.exec(decodeIfJson(output));
  return match ? match[1]! : null;
}

type ScenePreviewEntryLike = { command?: string; args?: unknown; output?: string; result?: unknown };

/** Per entry object: its preview output, or null. Entries are immutable snapshots. */
const previewOutputByEntry = new WeakMap<object, string | null>();

function previewOutputOf(entry: ScenePreviewEntryLike): string | null {
  const cached = previewOutputByEntry.get(entry);
  if (cached !== undefined) return cached;
  // Only an entry that ran `ade scene preview` can hold one. Checked on the
  // command and arguments (small) before any result is read, so a turn full of
  // large tool results is never stringified on each update.
  let invocation = entry.command ?? "";
  if (!invocation && entry.args !== undefined) {
    try { invocation = typeof entry.args === "string" ? entry.args : JSON.stringify(entry.args); } catch { invocation = ""; }
  }
  if (!/scene\s+preview/.test(invocation)) {
    previewOutputByEntry.set(entry, null);
    return null;
  }
  let text = entry.output ?? "";
  if (!text && entry.result !== undefined) {
    try { text = typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result); } catch { text = ""; }
  }
  // A preview still running has no output yet; remember only a final answer.
  if (!text) return null;
  const output = readScenePreviewPath(text) ? text : null;
  previewOutputByEntry.set(entry, output);
  return output;
}

/**
 * The output of the newest `ade scene preview` among a turn's tool entries, or
 * null. Reads a command's output or a tool's result, whatever the provider
 * reports it as.
 */
export function latestScenePreviewOutput(entries: ReadonlyArray<ScenePreviewEntryLike>): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const output = previewOutputOf(entries[index]!);
    if (output) return output;
  }
  return null;
}

export function ScenePreviewThumb({ output }: { output: string | null | undefined }) {
  if (!output || !readScenePreviewPath(output)) return null;
  return <SceneDrawingBox testId="chat-scene-preview-thumb" status="drafting" height={88} />;
}
