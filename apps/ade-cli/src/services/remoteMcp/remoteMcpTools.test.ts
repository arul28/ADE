import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliPlan } from "../../cli";
import { findTypedTool, TYPED_TOOLS, withToolImage, type TypedTool } from "./remoteMcpTools";

/** One value for every input a tool declares, so each flag it can emit is emitted. */
function everyInput(tool: TypedTool): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(tool.properties)) {
    const spec = schema as { type?: string; enum?: unknown[]; minimum?: number };
    if (spec.enum?.length) input[name] = spec.enum[0];
    else if (spec.type === "integer") input[name] = spec.minimum ?? 1;
    else if (spec.type === "boolean") input[name] = true;
    else if (spec.type === "object") input[name] = { 1: "yes" };
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
    expect(() => buildCliPlan(built.argv)).not.toThrow();
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

  it("keeps local paths out of a sheet failure it reports", () => {
    const tool = findTypedTool("proof_review");
    if (!tool?.shape) throw new Error("proof_review has no shape");
    const shaped = tool.shape({
      artifactId: "proof-1",
      media: "video",
      path: "/Users/someone/Projects/client/.ade/artifacts/demo.mp4",
      sheetPath: null,
      sheetError: "ffmpeg: /Users/someone/Projects/client/.ade/artifacts/demo.mp4: Invalid data; C:\\Users\\someone\\out.png",
      chatSessionId: "chat-1",
    }, { session: "chat-1" }, { ownership: null }) as Record<string, unknown>;
    expect(shaped.sheetError).toBe("ffmpeg: <file>: Invalid data; <file>");
    expect(JSON.stringify(shaped)).not.toContain("someone");
    expect(shaped.artifactId).toBe("proof-1");
  });
});
