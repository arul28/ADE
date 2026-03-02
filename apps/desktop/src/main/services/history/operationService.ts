import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import type { ListOperationsArgs, OperationRecord } from "../../../shared/types";
import { isRecord, safeJsonParse } from "../shared/utils";

type OperationStatus = "running" | "succeeded" | "failed" | "canceled";

type OperationMetadata = Record<string, unknown>;

function safeParseMetadata(raw: string | null | undefined): OperationMetadata {
  const parsed = safeJsonParse(raw, null);
  return isRecord(parsed) ? parsed : {};
}

function toJson(value: OperationMetadata): string {
  return JSON.stringify(value);
}

export function createOperationService({
  db,
  projectId
}: {
  db: AdeDb;
  projectId: string;
}) {
  const nowIso = () => new Date().toISOString();

  const start = (args: {
    laneId?: string | null;
    kind: string;
    preHeadSha?: string | null;
    metadata?: OperationMetadata;
  }): { operationId: string; startedAt: string } => {
    const operationId = randomUUID();
    const startedAt = nowIso();
    const metadata = args.metadata ?? {};

    db.run(
      `
        insert into operations(
          id,
          project_id,
          lane_id,
          kind,
          started_at,
          ended_at,
          status,
          pre_head_sha,
          post_head_sha,
          metadata_json
        ) values(?, ?, ?, ?, ?, null, 'running', ?, null, ?)
      `,
      [operationId, projectId, args.laneId ?? null, args.kind, startedAt, args.preHeadSha ?? null, toJson(metadata)]
    );

    return { operationId, startedAt };
  };

  const finish = (args: {
    operationId: string;
    status: Exclude<OperationStatus, "running">;
    postHeadSha?: string | null;
    metadataPatch?: OperationMetadata;
  }): void => {
    const endedAt = nowIso();

    const existing = db.get<{ metadata_json: string | null }>(
      "select metadata_json from operations where id = ? and project_id = ? limit 1",
      [args.operationId, projectId]
    );

    const mergedMetadata = {
      ...safeParseMetadata(existing?.metadata_json),
      ...(args.metadataPatch ?? {})
    };

    db.run(
      `
        update operations
        set ended_at = ?,
            status = ?,
            post_head_sha = ?,
            metadata_json = ?
        where id = ? and project_id = ?
      `,
      [endedAt, args.status, args.postHeadSha ?? null, toJson(mergedMetadata), args.operationId, projectId]
    );
  };

  return {
    start,
    finish,

    recordCompleted(args: {
      laneId?: string | null;
      kind: string;
      preHeadSha?: string | null;
      postHeadSha?: string | null;
      status?: Exclude<OperationStatus, "running">;
      metadata?: OperationMetadata;
    }): { operationId: string } {
      const started = start({
        laneId: args.laneId,
        kind: args.kind,
        preHeadSha: args.preHeadSha,
        metadata: args.metadata
      });
      finish({
        operationId: started.operationId,
        status: args.status ?? "succeeded",
        postHeadSha: args.postHeadSha,
        metadataPatch: args.metadata
      });
      return { operationId: started.operationId };
    },

    list(args: ListOperationsArgs = {}): OperationRecord[] {
      const where = ["o.project_id = ?"];
      const params: Array<string | number> = [projectId];

      if (args.laneId) {
        where.push("o.lane_id = ?");
        params.push(args.laneId);
      }

      if (args.kind) {
        where.push("o.kind = ?");
        params.push(args.kind);
      }

      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(1000, Math.floor(args.limit))) : 300;
      params.push(limit);

      const rows = db.all<OperationRecord>(
        `
          select
            o.id as id,
            o.lane_id as laneId,
            l.name as laneName,
            o.kind as kind,
            o.started_at as startedAt,
            o.ended_at as endedAt,
            o.status as status,
            o.pre_head_sha as preHeadSha,
            o.post_head_sha as postHeadSha,
            o.metadata_json as metadataJson
          from operations o
          left join lanes l on l.id = o.lane_id
          where ${where.join(" and ")}
          order by o.started_at desc
          limit ?
        `,
        params
      );

      return rows;
    }
  };
}
