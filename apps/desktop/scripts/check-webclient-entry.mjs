import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(scriptDir, "../dist/web-client");
const indexPath = path.join(outputDir, "index.html");
const maxRawBytes = 1000 * 1024;
const forbiddenChunkName = /monaco|graph|terminal|markdown|xterm|katex|pdf/i;

function readAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function localOutputPath(reference) {
  const url = new URL(reference, "https://webclient.invalid/");
  if (url.origin !== "https://webclient.invalid") return null;

  const outputPath = path.resolve(outputDir, `.${decodeURIComponent(url.pathname)}`);
  const relativePath = path.relative(outputDir, outputPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Webclient entry reference escapes the output directory: ${reference}`);
  }
  return outputPath;
}

if (!fs.existsSync(indexPath)) {
  throw new Error(`Webclient entry check could not find ${indexPath}`);
}

const html = fs.readFileSync(indexPath, "utf8");
const checkedReferences = [];
const referencedJavaScript = new Set();

for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
  const tagName = match[1].toLowerCase();
  const tag = match[0];
  const relation = readAttribute(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
  const isCheckedLink = tagName === "link"
    && (relation.includes("modulepreload") || relation.includes("stylesheet"));
  if (tagName !== "script" && !isCheckedLink) continue;

  const reference = readAttribute(tag, tagName === "script" ? "src" : "href");
  if (!reference) continue;
  checkedReferences.push(reference);

  const chunkName = path.basename(new URL(reference, "https://webclient.invalid/").pathname);
  if (forbiddenChunkName.test(chunkName)) {
    throw new Error(`Webclient entry references forbidden heavy chunk: ${reference}`);
  }

  const isJavaScript = tagName === "script" || relation.includes("modulepreload");
  const outputPath = isJavaScript ? localOutputPath(reference) : null;
  if (outputPath) referencedJavaScript.add(outputPath);
}

let totalRawBytes = Buffer.byteLength(html);
for (const javaScriptPath of referencedJavaScript) {
  if (!fs.existsSync(javaScriptPath)) {
    throw new Error(`Webclient entry references missing JavaScript: ${javaScriptPath}`);
  }
  totalRawBytes += fs.statSync(javaScriptPath).size;
}

const totalRawKilobytes = totalRawBytes / 1024;
console.log(
  `Webclient entry graph: ${totalRawKilobytes.toFixed(1)} KB raw `
  + `(index.html + ${referencedJavaScript.size} JS file${referencedJavaScript.size === 1 ? "" : "s"})`,
);

if (totalRawBytes > maxRawBytes) {
  throw new Error(
    `Webclient entry graph exceeds 1000 KB raw: ${totalRawKilobytes.toFixed(1)} KB`,
  );
}

if (checkedReferences.length === 0) {
  throw new Error("Webclient entry check found no script, modulepreload, or stylesheet references");
}
