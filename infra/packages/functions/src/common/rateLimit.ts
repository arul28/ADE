import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { HostedJobType } from "../../../core/src/types";
import { ddb, nowIso } from "./awsClients";
import { sharedEnv } from "./env";
import { ApiError } from "./http";

const JOB_TOKEN_ESTIMATE: Record<HostedJobType, number> = {
  NarrativeGeneration: 8_000,
  ConflictResolution: 16_000,
  ProposeConflictResolution: 16_000,
  DraftPrDescription: 6_000
};

function minuteWindowKey(now: Date): string {
  return `jobs:minute:${now.toISOString().slice(0, 16)}`;
}

function dayWindowKey(now: Date): string {
  return `jobs:day:${now.toISOString().slice(0, 10)}`;
}

function dayTokenWindowKey(now: Date): string {
  return `tokens:day:${now.toISOString().slice(0, 10)}`;
}

function ttlSecondsFromNow(now: Date, seconds: number): number {
  return Math.floor(now.getTime() / 1000) + seconds;
}

async function incrementCounterWithLimit(args: {
  userId: string;
  windowKey: string;
  amount: number;
  limit: number;
  expiresAt: number;
  errorMessage: string;
  code: string;
}): Promise<number> {
  if (args.amount > args.limit) {
    throw new ApiError(429, {
      code: args.code,
      message: args.errorMessage,
      details: {
        windowKey: args.windowKey,
        limit: args.limit,
        amount: args.amount
      }
    });
  }

  const maxBefore = args.limit - args.amount;

  try {
    const response = await ddb.send(
      new UpdateCommand({
        TableName: sharedEnv.rateLimitsTableName,
        Key: {
          userId: args.userId,
          windowKey: args.windowKey
        },
        UpdateExpression: "set #count = if_not_exists(#count, :zero) + :amount, expiresAt = :expiresAt, updatedAt = :updatedAt",
        ConditionExpression: "attribute_not_exists(#count) OR #count <= :maxBefore",
        ExpressionAttributeNames: {
          "#count": "count"
        },
        ExpressionAttributeValues: {
          ":zero": 0,
          ":amount": args.amount,
          ":expiresAt": args.expiresAt,
          ":updatedAt": nowIso(),
          ":maxBefore": maxBefore
        },
        ReturnValues: "UPDATED_NEW"
      })
    );

    const attributes = response.Attributes as Record<string, unknown> | undefined;
    const count = Number(attributes?.count ?? args.amount);
    return Number.isFinite(count) ? count : args.amount;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "ConditionalCheckFailedException") {
      throw new ApiError(429, {
        code: args.code,
        message: args.errorMessage,
        details: {
          windowKey: args.windowKey,
          limit: args.limit,
          amount: args.amount
        }
      });
    }
    throw error;
  }
}

export async function enforceJobSubmissionLimits(args: {
  userId: string;
  type: HostedJobType;
}): Promise<{
  minuteCount: number;
  dailyCount: number;
  dailyEstimatedTokens: number;
}> {
  const now = new Date();
  const estimatedTokens = JOB_TOKEN_ESTIMATE[args.type] ?? 8_000;

  const [minuteCount, dailyCount, dailyEstimatedTokens] = await Promise.all([
    incrementCounterWithLimit({
      userId: args.userId,
      windowKey: minuteWindowKey(now),
      amount: 1,
      limit: sharedEnv.rateLimitJobsPerMinute,
      expiresAt: ttlSecondsFromNow(now, 2 * 60 * 60),
      code: "RATE_LIMIT_PER_MINUTE_EXCEEDED",
      errorMessage: `Too many job submissions in a short period. Limit: ${sharedEnv.rateLimitJobsPerMinute} per minute.`
    }),
    incrementCounterWithLimit({
      userId: args.userId,
      windowKey: dayWindowKey(now),
      amount: 1,
      limit: sharedEnv.rateLimitDailyJobs,
      expiresAt: ttlSecondsFromNow(now, 10 * 24 * 60 * 60),
      code: "DAILY_JOB_LIMIT_EXCEEDED",
      errorMessage: `Daily hosted job limit reached. Limit: ${sharedEnv.rateLimitDailyJobs} jobs per day.`
    }),
    incrementCounterWithLimit({
      userId: args.userId,
      windowKey: dayTokenWindowKey(now),
      amount: estimatedTokens,
      limit: sharedEnv.rateLimitDailyEstimatedTokens,
      expiresAt: ttlSecondsFromNow(now, 10 * 24 * 60 * 60),
      code: "DAILY_TOKEN_BUDGET_EXCEEDED",
      errorMessage: `Daily hosted token budget reached. Limit: ${sharedEnv.rateLimitDailyEstimatedTokens} estimated tokens per day.`
    })
  ]);

  return {
    minuteCount,
    dailyCount,
    dailyEstimatedTokens
  };
}
