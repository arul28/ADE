import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import { s3 } from "./awsClients";

export async function s3ObjectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function putObject(args: {
  bucket: string;
  key: string;
  body: string | Uint8Array;
  contentType?: string;
}): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: args.bucket,
      Key: args.key,
      Body: args.body,
      ContentType: args.contentType
    })
  );
}

export async function getObjectText(args: { bucket: string; key: string }): Promise<string> {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: args.bucket,
      Key: args.key
    })
  );

  const body = response.Body;
  if (!body) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function deletePrefix(args: { bucket: string; prefix: string }): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;

  while (true) {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: args.bucket,
        Prefix: args.prefix,
        ContinuationToken: continuationToken
      })
    );

    const keys = (listed.Contents ?? []).map((obj) => obj.Key).filter((key): key is string => Boolean(key));
    if (keys.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: args.bucket,
          Delete: {
            Objects: keys.map((Key) => ({ Key }))
          }
        })
      );
      deleted += keys.length;
    }

    if (!listed.IsTruncated || !listed.NextContinuationToken) {
      break;
    }

    continuationToken = listed.NextContinuationToken;
  }

  return deleted;
}

export async function listObjectsByPrefix(args: {
  bucket: string;
  prefix: string;
  maxKeys?: number;
}): Promise<Array<{ key: string; size: number; lastModified: string | null }>> {
  const out: Array<{ key: string; size: number; lastModified: string | null }> = [];
  let continuationToken: string | undefined;
  const cap = typeof args.maxKeys === "number" && args.maxKeys > 0 ? Math.floor(args.maxKeys) : 10_000;

  while (true) {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: args.bucket,
        Prefix: args.prefix,
        ContinuationToken: continuationToken,
        MaxKeys: Math.min(1000, Math.max(1, cap - out.length))
      })
    );
    for (const entry of listed.Contents ?? []) {
      const key = entry.Key;
      if (!key) continue;
      out.push({
        key,
        size: Number(entry.Size ?? 0) || 0,
        lastModified: entry.LastModified ? entry.LastModified.toISOString() : null
      });
      if (out.length >= cap) return out;
    }

    if (!listed.IsTruncated || !listed.NextContinuationToken) break;
    continuationToken = listed.NextContinuationToken;
  }

  return out;
}

export async function deleteObjects(args: { bucket: string; keys: string[] }): Promise<number> {
  const keys = args.keys.filter((key) => typeof key === "string" && key.trim().length > 0);
  if (!keys.length) return 0;
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: args.bucket,
        Delete: {
          Objects: batch.map((Key) => ({ Key }))
        }
      })
    );
    deleted += batch.length;
  }
  return deleted;
}
