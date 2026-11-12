import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliPlan } from "../../cli";
import { findTypedTool, TYPED_TOOLS, withToolImage, type TypedTool } from "./remoteMcpTools";

/** One value for every input a tool declares, so each flag it can emit is emitted. */
/** Inputs a tool refuses together: the test fills the other side. */
const EXCLUSIVE_INPUTS: Readonly<Record<string, readonly string[]>> = {
  chat_start: ["lane", "dry_run"],
  lanes_create: ["existing_branch"],
};

function everyInput(tool: TypedTool): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(tool.properties)) {
    if (EXCLUSIVE_INPUTS[tool.name]?.includes(name)) continue;
    const spec = schema as { type?: string; enum?: unknown[]; minimum?: number };
    if (spec.enum?.length) input[name] = spec.enum[0];
    else if (spec.type === "integer") input[name] = spec.minimum ?? 1;
    else if (spec.type === "boolean") input[name] = true;
    else if (spec.type === "object") input[name] = { 1: "yes" };
    else if (name.endsWith("_url")) input[name] = "https://example.com/hook";
    else input[name] = name === "provider" ? "codex" : name === "model" ? "openai/gpt-5.5" : `${name}-1`;
  }
  return input;
}

// The typed tools hand their argv to `ade`, on this computer or another one,
// so every flag they emit has to be one the CLI still accepts.
describe("ADE MCP typed tools", () => {
  it.each(TYPED_TOOLS.map((tool) => [tool.name, tool] as const))("%s builds argv the CLI accepts", (_name, tool) => {
    const built = tool.build(everyInput(tool));
    if (!("argv" in built)) throw new Error(`${tool.name} did not build: ${built.error}`);
    // The CLI reads `--stdin` while it builds the plan; the runner pipes the text, so stand it in here.
    const argv = built.argv.map((word) => (word === "--stdin" ? "--text=x" : word === "--notify-token-stdin" ? "--notify-token=x" : word));
    expect(() => buildCliPlan(argv)).not.toThrow();
  });
});

// A typed result names a file by path, and the picture goes to an agent on
// another computer: only an image inside the project's proof folders may
// leave, judged on the file a link resolves to.
describe("ADE MCP pictures", () => {
  it("sends only a picture inside the proof folders, links resolved", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mcp-outside-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mcp-project-"));
    const cache = path.join(root, ".ade", "cache");
    const artifacts = path.join(root, ".ade", "artifacts");
    fs.mkdirSync(cache, { recursive: true });
    fs.mkdirSync(artifacts, { recursive: true });
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    fs.writeFileSync(path.join(cache, "sheet.png"), png);
    fs.writeFileSync(path.join(root, "loose.png"), png);
    fs.writeFileSync(path.join(artifacts, "notes.json"), "{}");
    fs.writeFileSync(path.join(outside, "secret.png"), png);
    // Windows may refuse an unprivileged symlink; everywhere else it must work.
    const link = (target: string, at: string): string[] => {
      try {
        fs.symlinkSync(target, at);
        return [path.relative(root, at)];
      } catch (error) {
        if (process.platform !== "win32") throw error;
        return [];
      }
    };
    const linked = [
      ...link(path.join(artifacts, "notes.json"), path.join(cache, "named-like.png")),
      ...link(path.join(outside, "secret.png"), path.join(cache, "escape.png")),
    ];
    const tool = findTypedTool("proof_review");
    if (!tool) throw new Error("proof_review is not a typed tool");
    const answer = { content: [{ type: "text", text: "result" }] };
    const attach = async (file: string) => (await withToolImage(tool, { media: "image", path: file }, answer, root)).content;
    try {
      const sent = await attach(path.join(cache, "sheet.png"));
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") });
      for (const refused of ["loose.png", ...linked]) {
        const content = await attach(path.join(root, refused));
        expect(content.some((block) => block.type === "image"), refused).toBe(false);
        expect(content.at(-1)?.text, refused).toMatch(/^No picture attached: /);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each([
    {
      video: "/Users/someone/Projects/client/.ade/artifacts/demo.mp4",
      error: "ffmpeg: /Users/someone/Projects/client/.ade/artifacts/demo.mp4: Invalid data; C:\\Users\\someone\\out.png",
      shown: "ffmpeg: <file>: Invalid data; <file>",
    },
    {
      video: "/Users/some one/Client Project/.ade/artifacts/demo.mp4",
      error: "ffmpeg: /Users/some one/Client Project/.ade/artifacts/demo.mp4: Invalid; "
        + "/Users/some one/Client Project/.ade/cache/proof-review/out.png: cannot write",
      shown: "ffmpeg: <file>: Invalid; <project>/.ade/cache/proof-review/out.png: cannot write",
    },
  ])("keeps local paths out of a sheet failure it reports ($shown)", ({ video, error, shown }) => {
    const tool = findTypedTool("proof_review");
    if (!tool?.shape) throw new Error("proof_review has no shape");
    const shaped = tool.shape({
      artifactId: "proof-1",
      media: "video",
      path: video,
      sheetPath: null,
      sheetError: error,
      chatSessionId: "chat-1",
    }, { session: "chat-1" }, { ownership: null }) as Record<string, unknown>;
    expect(shaped.sheetError).toBe(shown);
    expect(JSON.stringify(shaped)).not.toMatch(/someone|some one|Client Project/);
    expect(shaped.artifactId).toBe("proof-1");
  });
});
