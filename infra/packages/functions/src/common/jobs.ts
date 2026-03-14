import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { HostedJobType, JobPayload } from "../../../core/src/types";
import { sqs } from "./awsClients";

export function buildJobPayload(args: {
  projectId: string;
  userId: string;
  jobId: string;
  type: HostedJobType;
  laneId: string;
  params: Record<string, unknown>;
  submittedAt: string;
}): JobPayload {
  return {
    projectId: args.projectId,
    userId: args.userId,
    jobId: args.jobId,
    type: args.type,
    laneId: args.laneId,
    params: args.params,
    submittedAt: args.submittedAt
  };
}

export async function enqueueJob(queueUrl: string, payload: JobPayload): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(payload)
    })
  );
}

export function parseJobMessage(body: string): JobPayload {
  const parsed = JSON.parse(body) as JobPayload;
  if (!parsed.projectId || !parsed.jobId || !parsed.type || !parsed.userId) {
    throw new Error("Invalid job payload");
  }
  return parsed;
}
