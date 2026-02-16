import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});

const JOBS_TABLE = process.env.JOBS_TABLE_NAME!;
const STAGE = process.env.APP_STAGE ?? "unknown";
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes

async function sweepStatus(status: "queued" | "processing"): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  let swept = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: JOBS_TABLE,
        IndexName: "statusIndex",
        KeyConditionExpression: "#status = :status AND submittedAt < :cutoff",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": status, ":cutoff": cutoff },
        ExclusiveStartKey: lastKey
      })
    );

    for (const item of result.Items ?? []) {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: JOBS_TABLE,
            Key: { projectId: item.projectId, jobId: item.jobId },
            UpdateExpression: "set #status = :failed, updatedAt = :now, completedAt = :now, #error = :err",
            ConditionExpression: "#status = :currentStatus",
            ExpressionAttributeNames: { "#status": "status", "#error": "error" },
            ExpressionAttributeValues: {
              ":failed": "failed",
              ":now": new Date().toISOString(),
              ":currentStatus": status,
              ":err": { code: "STALE_JOB_SWEPT", message: `Job stuck in '${status}' for over 60 minutes` }
            }
          })
        );
        swept++;
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
          console.error(JSON.stringify({
            event: "sweeper.update_error",
            stage: STAGE,
            projectId: item.projectId,
            jobId: item.jobId,
            error: err instanceof Error ? err.message : String(err)
          }));
        }
        // ConditionalCheckFailedException is expected — another process already updated
      }
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return swept;
}

export async function handler(): Promise<void> {
  const queuedSwept = await sweepStatus("queued");
  const processingSwept = await sweepStatus("processing");

  console.log(JSON.stringify({
    event: "sweeper.complete",
    stage: STAGE,
    queuedSwept,
    processingSwept,
    totalSwept: queuedSwept + processingSwept
  }));
}
