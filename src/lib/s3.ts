import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import { Readable } from 'stream';

const s3 = new S3Client({});

const bucket = process.env.S3_BUCKET!;

/** Re-usable SHA-256 helper (hex-lower). */
export const sha256 = (text: string) =>
  crypto.createHash('sha256').update(text).digest('hex');

/** Put a JSON-serialisable object. Optionally set TTL in seconds (Expires header). */
export async function putObject(key: string, data: unknown, expiresInSeconds?: number) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: 'application/json',
      ...(expiresInSeconds
        ? { Expires: new Date(Date.now() + expiresInSeconds * 1000) }
        : {}),
    })
  );
}

/** Get object; return parsed JSON or undefined if 404. */
export async function getObject<T = unknown>(key: string): Promise<T | undefined> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    const body = await streamToString(res.Body as Readable);
    return JSON.parse(body) as T;
  } catch (err: any) {
    if (err?.$metadata?.httpStatusCode === 404) return undefined;
    throw err;
  }
}

export async function putBinaryObject(key: string, buffer: Buffer, contentType: string, expiresInSeconds?: number) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ...(expiresInSeconds
        ? { Expires: new Date(Date.now() + expiresInSeconds * 1000) }
        : {}),
    })
  );
}

const streamToString = (stream: Readable): Promise<string> =>
  new Promise((res, rej) => {
    const chunks: any[] = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => res(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', rej);
  });
