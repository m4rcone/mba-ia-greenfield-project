import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
  S3Client,
  BucketAlreadyOwnedByYou,
} from '@aws-sdk/client-s3';

export function createMinioTestClient(): S3Client {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'streamtube',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'streamtube-secret',
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/** Unique per suite run so suites never share objects with dev buckets or each other. */
export function testBucketName(purpose: string): string {
  return `test-${purpose}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createTestBucket(
  client: S3Client,
  bucket: string,
): Promise<void> {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!(error instanceof BucketAlreadyOwnedByYou)) {
      throw error;
    }
  }
}

export async function emptyTestBucket(
  client: S3Client,
  bucket: string,
): Promise<void> {
  const uploads = await client.send(
    new ListMultipartUploadsCommand({ Bucket: bucket }),
  );
  for (const upload of uploads.Uploads ?? []) {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.Key,
        UploadId: upload.UploadId,
      }),
    );
  }

  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (page.Contents ?? []).map((object) => ({ Key: object.Key }));
    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
    }
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken);
}

export async function deleteTestBucket(
  client: S3Client,
  bucket: string,
): Promise<void> {
  await emptyTestBucket(client, bucket);
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}
