import { describe, expect, it } from "vitest";
import type { Agent37TemplateStatus } from "../../../shared/agent37";
import { AGENT37_API_BASE_URL } from "../../../shared/agent37";
import { createAgent37Client } from "./agent37Client";
import { createAgent37TemplateBuilder, type Agent37TemplateBuildRecord, type Agent37TemplateRecordStore } from "./agent37TemplateBuilder";

/**
 * Two computers on one account can check the template at the same moment, and
 * the account vault has no compare-and-set. A build only runs once it is
 * uploaded and started, so the claim rules decide whether one build runs or
 * two. Only Agent 37's HTTP API (fetch) and the account vault record are
 * stand-ins.
 */

function fakeAgent37Builds() {
  const calls: string[] = [];
  const builds = new Map<string, { status: string; created: number }>([
    ["b-theirs", { status: "succeeded", created: 100 }],
  ]);
  let template: { description: string | null } | null = null;
  let made = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const route = url.startsWith(AGENT37_API_BASE_URL) ? url.slice(AGENT37_API_BASE_URL.length) : url;
    calls.push(`${method} ${route}`);
    if (route === "/templates/ade") {
      if (method === "PATCH" && template) {
        template = { description: (JSON.parse(String(init?.body)) as { description: string }).description };
        return json(200, {});
      }
      return template ? json(200, { name: "ade", revision: 1, description: template.description }) : json(404, { error: { code: "not_found", message: "no" } });
    }
    if (route === "/template-builds" && method === "POST") {
      made += 1;
      const id = `b-ours-${made}`;
      builds.set(id, { status: "created", created: 200 + made });
      return json(201, { id, upload_url: `https://upload.invalid/${id}` });
    }
    const build = /^\/template-builds\/([^/]+)(\/start)?$/.exec(route);
    if (build) {
      const known = builds.get(build[1]!);
      if (!known) return json(404, { error: { code: "not_found", message: "no" } });
      if (build[2]) {
        // A started build finishes at once here, so a wrong start shows as a call, not a hang.
        known.status = "succeeded";
        return json(200, {});
      }
      // Agent 37 publishes the template (without ADE's marker) when a build succeeds.
      if (known.status === "succeeded" && !template) template = { description: null };
      return json(200, { id: build[1], status: known.status, created: known.created });
    }
    if (method === "PUT") return new Response(null, { status: 200 });
    return json(500, { error: { code: "internal_error", message: `no route ${method} ${route}` } });
  };
  return { fetch, calls };
}

/** The account vault's one record. */
function sharedRecord(behavior: "unreadable" | "write_refused" | "other_computer_claims_first") {
  let value: Agent37TemplateBuildRecord | null = null;
  const store: Agent37TemplateRecordStore = {
    read: async () => {
      if (behavior === "unreadable") throw new Error("the account vault couldn't be read");
      return value;
    },
    write: async (record) => {
      if (behavior === "write_refused") return;
      // Another computer's claim for the same template lands right after ours.
      value = behavior === "other_computer_claims_first" && record.buildId !== "b-theirs"
        ? { ...record, buildId: "b-theirs", startedAt: record.startedAt - 1_000, by: "other computer" }
        : record;
    },
    clear: async () => {
      value = null;
    },
  };
  return { store, current: () => value };
}

describe("Agent 37 template build claims", () => {
  it.each([
    { record: "unreadable", creates: false, finalState: "failed" },
    { record: "write_refused", creates: true, finalState: "failed" },
    { record: "other_computer_claims_first", creates: true, finalState: "ready" },
  ] as const)("a shared record that is $record never lets this computer upload or start a second build", async ({ record, creates, finalState }) => {
    const fake = fakeAgent37Builds();
    const shared = sharedRecord(record);
    const statuses: Agent37TemplateStatus[] = [];
    const builder = createAgent37TemplateBuilder({
      client: async () => createAgent37Client({ apiKey: "sk_test_fixture", fetch: fake.fetch }),
      templateName: () => "ade",
      adeVersion: null,
      readContext: async () => ({ dockerfile: "FROM debian:12\nARG ADE_VERSION=latest\n", entrypoint: "#!/bin/sh\nexec ade serve\n" }),
      records: shared.store,
      onStatus: (status) => statuses.push(status),
      sleep: async () => undefined,
    });

    await builder.ensure();

    expect(fake.calls.some((call) => call === "POST /template-builds")).toBe(creates);
    expect(fake.calls.filter((call) => call.startsWith("PUT ") || /^POST \/template-builds\/[^/]+\/start$/.test(call))).toEqual([]);
    expect(statuses.at(-1)?.state).toBe(finalState);
    expect(shared.current()).toBeNull();
    if (finalState === "ready") {
      // Ready only once Agent 37 shows the template with ADE's marker.
      expect(fake.calls).toContain("PATCH /templates/ade");
      expect(statuses.at(-1)?.usable).toBe(true);
    }
  });
});
