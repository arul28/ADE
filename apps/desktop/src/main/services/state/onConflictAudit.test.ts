import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type ConflictTarget = {
  file: string;
  table: string;
  columns: string;
};

const APPROVED_CONFLICT_TARGETS: ConflictTarget[] = [
  {
    file: "src/main/services/automations/automationService.ts",
    table: "automation_ingress_cursors",
    columns: "project_id,source",
  },
  {
    file: "src/main/services/conflicts/conflictService.ts",
    table: "rebase_deferred",
    columns: "lane_id,project_id",
  },
  {
    file: "src/main/services/conflicts/conflictService.ts",
    table: "rebase_dismissed",
    columns: "lane_id,project_id",
  },
  {
    file: "src/main/services/cto/ctoStateService.ts",
    table: "cto_core_memory_state",
    columns: "project_id",
  },
  {
    file: "src/main/services/cto/ctoStateService.ts",
    table: "cto_identity_state",
    columns: "project_id",
  },
  {
    file: "src/main/services/cto/flowPolicyService.ts",
    table: "cto_flow_policies",
    columns: "project_id",
  },
  {
    file: "src/main/services/cto/linearIngressService.ts",
    table: "linear_ingress_state",
    columns: "project_id",
  },
  {
    file: "src/main/services/cto/linearSyncService.ts",
    table: "linear_sync_state",
    columns: "project_id",
  },
  {
    file: "src/main/services/cto/workerAgentService.ts",
    table: "worker_agents",
    columns: "id",
  },
  {
    file: "src/main/services/lanes/laneService.ts",
    table: "lane_state_snapshots",
    columns: "lane_id",
  },
  {
    file: "src/main/services/memory/proceduralLearningService.ts",
    table: "memory_procedure_details",
    columns: "memory_id",
  },
  {
    file: "src/main/services/orchestrator/chatMessageService.ts",
    table: "orchestrator_chat_threads",
    columns: "id",
  },
  {
    file: "src/main/services/orchestrator/metricsAndUsage.ts",
    table: "mission_metrics_config",
    columns: "mission_id",
  },
  {
    file: "src/main/services/orchestrator/recoveryService.ts",
    table: "orchestrator_attempt_runtime",
    columns: "attempt_id",
  },
  {
    file: "src/main/services/orchestrator/teamRuntimeState.ts",
    table: "orchestrator_run_state",
    columns: "run_id",
  },
  {
    file: "src/main/services/processes/processService.ts",
    table: "process_runtime",
    columns: "project_id,lane_id,process_key",
  },
  {
    file: "src/main/services/prs/prService.ts",
    table: "pull_request_snapshots",
    columns: "pr_id",
  },
  {
    file: "src/main/services/prs/queueLandingService.ts",
    table: "queue_landing_state",
    columns: "id",
  },
  {
    file: "src/main/services/sessions/sessionDeltaService.ts",
    table: "session_deltas",
    columns: "session_id",
  },
  {
    file: "src/main/services/sync/deviceRegistryService.ts",
    table: "devices",
    columns: "device_id",
  },
  {
    file: "src/main/services/sync/deviceRegistryService.ts",
    table: "sync_cluster_state",
    columns: "cluster_id",
  },
].sort((a, b) =>
  a.file.localeCompare(b.file)
  || a.table.localeCompare(b.table)
  || a.columns.localeCompare(b.columns),
);

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".ts") && !fullPath.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function readStaticSql(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return null;
  }
  return null;
}

function scanConflictTargets(): ConflictTarget[] {
  const entries: ConflictTarget[] = [];
  const root = path.resolve(process.cwd(), "src/main");
  for (const filePath of listTsFiles(root)) {
    const sourceText = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "run") {
          const sql = readStaticSql(node.arguments[0]);
          if (sql) {
            const match = sql.match(/insert\s+into\s+([a-zA-Z0-9_]+)\s*\([\s\S]*?on\s+conflict\s*\(([^)]+)\)/i);
            if (match) {
              entries.push({
                file: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
                table: match[1],
                columns: match[2].split(",").map((value) => value.trim()).join(","),
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return entries.sort((a, b) =>
    a.file.localeCompare(b.file)
    || a.table.localeCompare(b.table)
    || a.columns.localeCompare(b.columns),
  );
}

describe("ON CONFLICT audit", () => {
  it("only uses audited upsert targets in main-process code", () => {
    const discovered = scanConflictTargets();
    expect(discovered).toEqual(APPROVED_CONFLICT_TARGETS);
  });
});
