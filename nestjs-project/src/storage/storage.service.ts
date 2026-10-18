import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  PRESIGNED_PART_URL_TTL_SECONDS,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
} from './storage.constants';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface PresignGetOptions {
  expiresIn?: number;
  responseContentType?: string;
  responseContentDisposition?: string;
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async createMultipartUpload(
    bucket: string,
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(`Storage returned no UploadId for ${bucket}/${key}`);
    }
    return UploadId;
  }

  async listParts(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let partNumberMarker: string | undefined;
    let isTruncated = true;

    while (isTruncated) {
      const page = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: partNumberMarker,
        }),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber!,
          etag: part.ETag!,
          size: part.Size ?? 0,
        });
      }
      isTruncated = page.IsTruncated === true;
      partNumberMarker = page.NextPartNumberMarker;
    }

    return parts;
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** Returns the object's size in bytes, or `null` when it does not exist. */
  async headObject(bucket: string, key: string): Promise<number | null> {
    try {
      const { ContentLength } = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return ContentLength ?? 0;
    } catch (error) {
      if (error instanceof NotFound) {
        return null;
      }
      throw error;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  }

  async deletePrefix(bucket: string, prefix: string): Promise<void> {
    let continuationToken: string | undefined;

    do {
      const page = await this.internalClient.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (page.Contents ?? []).map((object) => ({ Key: object.Key }));
      if (keys.length > 0) {
        await this.internalClient.send(
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

  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async presignUploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn = PRESIGNED_PART_URL_TTL_SECONDS,
  ): Promise<string> {
    return await getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async presignGet(
    bucket: string,
    key: string,
    options: PresignGetOptions = {},
  ): Promise<string> {
    return await getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentType: options.responseContentType,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: options.expiresIn ?? this.storage.presignedGetTtlSeconds },
    );
  }

  /** Signed against the internal endpoint — for the worker's ffprobe/ffmpeg input. */
  async presignInternalGet(
    bucket: string,
    key: string,
    expiresIn = this.storage.presignedGetTtlSeconds,
  ): Promise<string> {
    return await getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn },
    );
  }

  /** Path-style URL for objects in anonymously readable buckets (thumbnails). */
  getPublicObjectUrl(bucket: string, key: string): string {
    const endpoint = this.storage.publicEndpoint.replace(/\/+$/, '');
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    return `${endpoint}/${bucket}/${encodedKey}`;
  }
}
