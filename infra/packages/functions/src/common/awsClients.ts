import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const dynamoClient = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    removeUndefinedValues: true
  }
});

export const s3 = new S3Client({});
export const sqs = new SQSClient({});
export const secretsManager = new SecretsManagerClient({});

export function nowIso(): string {
  return new Date().toISOString();
}
