import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// The desktop client's copy of the contract. It is Node-free on purpose, so
// the Worker suite can import it and hold the two copies to each other.
import * as client from "../../desktop/src/shared/routerRegistry";
import * as server from "../src/modelRegistryContract";
import { isModelRegistryRequest, MIN_AA_MODELS, refreshModelRegistry, AA_MODELS_URL, AA_CODING_AGENTS_URL, MODELS_DEV_URL } from "../src/modelRegistry";
import { FakeD1Database } from "./fakeD1";

/**
 * Exact type equality. `npm run typecheck` covers the test directory, so a
 * field added, dropped, renamed or retyped in either copy fails it there; the
 * runtime checks below cover the constants and the guard.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const sameSnapshot: Equal<client.ModelRegistrySnapshot, server.ModelRegistrySnapshot> = true;
const sameModel: Equal<client.ModelRegistryModel, server.ModelRegistryModel> = true;
const sameAgentRow: Equal<client.ModelRegistryAgentRow, server.ModelRegistryAgentRow> = true;
const samePrice: Equal<client.ModelRegistryPrice, server.ModelRegistryPrice> = true;
const sameSourceStatus: Equal<client.ModelRegistrySourceStatus, server.ModelRegistrySourceStatus> = true;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("model registry contract (desktop client vs Worker)", () => {
  it("names the same path, schema version, attribution and price channels", () => {
    expect([sameSnapshot, sameModel, sameAgentRow, samePrice, sameSourceStatus]).toEqual([true, true, true, true, true]);
    expect(client.MODEL_REGISTRY_PATH).toBe(server.MODEL_REGISTRY_PATH);
    expect(isModelRegistryRequest(new URL(client.MODEL_REGISTRY_PATH, "https://directory.test/"))).toBe(true);
    expect(client.MODEL_REGISTRY_SCHEMA_VERSION).toBe(server.MODEL_REGISTRY_SCHEMA_VERSION);
    expect(client.MODEL_REGISTRY_AA_ATTRIBUTION).toBe(server.MODEL_REGISTRY_AA_ATTRIBUTION);
    expect([...client.MODEL_REGISTRY_PRICE_CHANNELS]).toEqual([...server.MODEL_REGISTRY_PRICE_CHANNELS]);
  });

  it("stores a snapshot the client accepts", async () => {
    const records = Array.from({ length: MIN_AA_MODELS }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      slug: `model-${index}`,
      name: `Model ${index}`,
      intelligenceIndexIsEstimated: false,
    }));
    const pages: Record<string, string> = {
      [AA_MODELS_URL]: `<script>self.__next_f.push([1,${JSON.stringify(`3:${JSON.stringify(records)}\n`)}])</script>`,
      [AA_CODING_AGENTS_URL]: fixture("aa-coding-agents-page.html"),
      [MODELS_DEV_URL]: fixture("models-dev.json"),
    };
    const db = new FakeD1Database();
    const result = await refreshModelRegistry(
      { DB: db as unknown as D1Database, CLERK_JWKS_URL: "", CLERK_ISSUER: "", CLERK_OAUTH_CLIENT_ID: "" },
      { now: () => Date.UTC(2026, 8, 29), fetchImpl: (async (input: RequestInfo | URL) => new Response(pages[String(input)])) as typeof fetch },
    );
    expect(result.stored).toBe(true);
    const stored: unknown = JSON.parse(db.modelRegistrySnapshots.at(-1)!.body);
    expect(client.isModelRegistrySnapshot(stored)).toBe(true);
    expect(server.isModelRegistrySnapshot(stored)).toBe(true);
  });
});
