import { encodeOpenCodeRegistryId } from "../../../shared/modelRegistry";
import { resolveOpenCodeExecutablePath } from "./openCodeRuntime";

export type OpenCodeCatalogModel = {
  id: string;
  displayName: string;
  providerId: string;
  reasoningTiers: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
};

type VerboseCatalogRecord = {
  id?: string;
  name?: string;
  providerID?: string;
  limit?: {
    context?: number;
    output?: number;
  };
  variants?: Record<string, unknown>;
};

function parseVerboseModelCatalog(stdout: string): OpenCodeCatalogModel[] {
  const lines = stdout.split(/\r?\n/);
  const models: OpenCodeCatalogModel[] = [];
  let currentId = "";
  let jsonLines: string[] = [];
  let braceDepth = 0;

  const flushJson = () => {
    if (!currentId || jsonLines.length === 0) return;
    try {
      const parsed = JSON.parse(jsonLines.join("\n")) as VerboseCatalogRecord;
      const providerId = parsed.providerID?.trim() || "opencode";
      const modelId =
        parsed.id?.trim()
        || currentId.replace(new RegExp(`^${providerId}/`, "i"), "").trim()
        || currentId.replace(/^.*?\//, "").trim();
      if (!modelId) return;
      const reasoningTiers = Object.keys(parsed.variants ?? {}).filter(Boolean);
      const registryId = encodeOpenCodeRegistryId(providerId, modelId);
      models.push({
        id: registryId,
        displayName: parsed.name?.trim() || modelId,
        providerId,
        reasoningTiers,
        ...(typeof parsed.limit?.context === "number" ? { contextWindow: parsed.limit.context } : {}),
        ...(typeof parsed.limit?.output === "number" ? { maxOutputTokens: parsed.limit.output } : {}),
      });
    } catch {
      // Ignore malformed entries and fall back to the plain id list below if needed.
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (braceDepth === 0 && trimmed.startsWith("{")) {
      jsonLines = [line];
      braceDepth += (line.match(/\{/g) ?? []).length;
      braceDepth -= (line.match(/\}/g) ?? []).length;
      if (braceDepth === 0) {
        flushJson();
        jsonLines = [];
      }
      continue;
    }

    if (braceDepth > 0) {
      jsonLines.push(line);
      braceDepth += (line.match(/\{/g) ?? []).length;
      braceDepth -= (line.match(/\}/g) ?? []).length;
      if (braceDepth === 0) {
        flushJson();
        jsonLines = [];
      }
      continue;
    }

    if (!trimmed.startsWith("{")) {
      currentId = trimmed;
    }
  }

  return models;
}

function parsePlainModelCatalog(stdout: string): OpenCodeCatalogModel[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(opencode|lmstudio|ollama|anthropic|openai|google|mistral)\/\S+/i.test(line))
    .map((lineKey) => {
      const slash = lineKey.indexOf("/");
      const providerId = slash > 0 ? lineKey.slice(0, slash).trim().toLowerCase() : "opencode";
      const tail = slash > 0 ? lineKey.slice(slash + 1).trim() : lineKey;
      return {
        id: encodeOpenCodeRegistryId(providerId, tail),
        displayName: tail,
        providerId,
        reasoningTiers: [],
      };
    });
}

export async function listOpenCodeCatalogModels(): Promise<OpenCodeCatalogModel[]> {
  const executable = resolveOpenCodeExecutablePath();
  if (!executable) return [];
  const [{ execFile }, { promisify }] = await Promise.all([
    import("node:child_process"),
    import("node:util"),
  ]);
  const execFileAsync = promisify(execFile);

  const { stdout } = await execFileAsync(executable, ["models", "--verbose"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  });

  const verboseModels = parseVerboseModelCatalog(stdout);
  if (verboseModels.length > 0) return verboseModels;
  return parsePlainModelCatalog(stdout);
}
