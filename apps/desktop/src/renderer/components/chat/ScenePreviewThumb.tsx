import { useEffect, useState } from "react";
import { Sparkle, WarningCircle } from "@phosphor-icons/react";

import { readAttachmentImageDataUrl } from "../../lib/attachmentImage";
import { COLORS } from "../lanes/laneDesignTokens";
import { useChatRuntimeScope } from "./ChatRuntimeScope";

/**
 * The picture an agent took of its own scene with `ade scene preview`, shown
 * under the command that took it.
 *
 * The preview is the agent checking its work before it puts a scene in its
 * reply. Without this the reader saw a shell row with a file path; with it they
 * can watch the scene being drafted and fixed. Read-only and small: the real
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

/** True when the preview reported problems (its first line, or `"ok": false`). */
function previewHadProblems(output: string): boolean {
  return /problems found/.test(output) || /"ok"\s*:\s*false/.test(output);
}

export function ScenePreviewThumb({ output }: { output: string | null | undefined }) {
  const path = readScenePreviewPath(output);
  const { pin } = useChatRuntimeScope();
  // Stamped with the path it was read for: a newer preview reuses this
  // component, and its first render must not show the previous picture.
  const [loaded, setLoaded] = useState<{ path: string; src: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    void readAttachmentImageDataUrl(path, pin)
      .then(({ dataUrl }) => { if (!cancelled) setLoaded({ path, src: dataUrl }); })
      .catch(() => { if (!cancelled) setLoaded(null); });
    return () => { cancelled = true; };
  }, [path, pin]);
  if (!path || !loaded || loaded.path !== path) return null;
  const problems = previewHadProblems(output ?? "");
  return (
    <div className="mt-1 mb-1 w-fit max-w-full" data-testid="chat-scene-preview-thumb">
      <img
        src={loaded.src}
        alt="Scene preview"
        className="block max-h-40 max-w-[360px] rounded-md object-contain object-left-top"
        style={{ border: `1px solid ${COLORS.borderMuted}` }}
        draggable={false}
      />
      <div className="mt-1 inline-flex items-center gap-1 text-[11px]" style={{ color: problems ? COLORS.warning : COLORS.textMuted }}>
        {problems ? <WarningCircle size={11} weight="bold" /> : <Sparkle size={10} weight="fill" style={{ color: COLORS.accent }} />}
        {problems ? "Scene preview: problems found" : "Scene preview"}
      </div>
    </div>
  );
}
