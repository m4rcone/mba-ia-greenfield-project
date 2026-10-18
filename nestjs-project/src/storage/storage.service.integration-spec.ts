import { S3Client, type ListPartsCommandInput } from '@aws-sdk/client-s3';
import { ConfigModule, registerAs } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  createMinioTestClient,
  createTestBucket,
  deleteTestBucket,
  emptyTestBucket,
  testBucketName,
} from '../test/minio';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService, type UploadedPart } from './storage.service';

const MIN_PART_SIZE = 5 * 1024 * 1024;

async function compileStorage(
  overrides: { publicEndpoint?: string } = {},
): Promise<TestingModule> {
  // Same namespace as storageConfig, so storageConfig.KEY resolves to this.
  const testStorageConfig = registerAs('storage', () => ({
    ...storageConfig(),
    ...overrides,
  }));
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [testStorageConfig] }),
      StorageModule,
    ],
  }).compile();
}

async function putPart(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  expect(res.status).toBe(200);
  const etag = res.headers.get('etag');
  expect(etag).toBeTruthy();
  return etag!;
}

describe('StorageService (integration)', () => {
  const bucket = testBucketName('storage');
  let adminClient: S3Client;
  let module: TestingModule;
  let storage: StorageService;

  beforeAll(async () => {
    adminClient = createMinioTestClient();
    await createTestBucket(adminClient, bucket);
    // Presigned URLs are fetched from inside the container, so the "public"
    // endpoint must be one this process can reach (SigV4 signs the Host).
    module = await compileStorage({ publicEndpoint: process.env.S3_ENDPOINT });
    storage = module.get(StorageService);
  });

  afterEach(async () => {
    await emptyTestBucket(adminClient, bucket);
  });

  afterAll(async () => {
    await deleteTestBucket(adminClient, bucket);
    adminClient.destroy();
    await module.close();
  });

  describe('multipart upload', () => {
    it('should assemble an object from 2 parts uploaded via presigned URLs', async () => {
      // Arrange
      const key = 'videos/two-parts/original';
      const part1 = Buffer.alloc(MIN_PART_SIZE, 1);
      const part2 = Buffer.alloc(1234, 2);
      const uploadId = await storage.createMultipartUpload(
        bucket,
        key,
        'video/mp4',
      );

      // Act
      await putPart(
        await storage.presignUploadPart(bucket, key, uploadId, 1),
        part1,
      );
      await putPart(
        await storage.presignUploadPart(bucket, key, uploadId, 2),
        part2,
      );
      const parts = await storage.listParts(bucket, key, uploadId);
      await storage.completeMultipartUpload(bucket, key, uploadId, parts);

      // Assert
      expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
      expect(await storage.headObject(bucket, key)).toBe(
        part1.length + part2.length,
      );
    });

    it('should follow listParts pagination until the last page', async () => {
      // Arrange — force 1 part per page against the real server
      const key = 'videos/paginated/original';
      const uploadId = await storage.createMultipartUpload(
        bucket,
        key,
        'video/mp4',
      );
      for (const partNumber of [1, 2, 3]) {
        await putPart(
          await storage.presignUploadPart(bucket, key, uploadId, partNumber),
          Buffer.alloc(16, partNumber),
        );
      }
      const internalClient = module.get<S3Client>(S3_INTERNAL_CLIENT);
      let listPartsCalls = 0;
      internalClient.middlewareStack.add(
        (next, context) => (args) => {
          if (context.commandName === 'ListPartsCommand') {
            listPartsCalls++;
            (args.input as ListPartsCommandInput).MaxParts = 1;
          }
          return next(args);
        },
        { step: 'initialize', name: 'forceOnePartPerPage' },
      );

      // Act
      let parts: UploadedPart[];
      try {
        parts = await storage.listParts(bucket, key, uploadId);
      } finally {
        internalClient.middlewareStack.remove('forceOnePartPerPage');
      }

      // Assert
      expect(parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
      expect(listPartsCalls).toBe(3);
    });

    it('should make listParts fail with NoSuchUpload after abort', async () => {
      // Arrange
      const key = 'videos/aborted/original';
      const uploadId = await storage.createMultipartUpload(
        bucket,
        key,
        'video/mp4',
      );

      // Act
      await storage.abortMultipartUpload(bucket, key, uploadId);

      // Assert
      await expect(
        storage.listParts(bucket, key, uploadId),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    });
  });

  describe('object operations', () => {
    it('should return null from headObject for a missing object', async () => {
      expect(await storage.headObject(bucket, 'missing/key')).toBeNull();
    });

    it('should put an object with its content type and delete it', async () => {
      // Arrange
      const key = 'thumbnails/abc/default.jpg';
      const body = Buffer.from('fake-jpeg');

      // Act
      await storage.putObject(bucket, key, body, 'image/jpeg');
      const res = await fetch(await storage.presignGet(bucket, key));

      // Assert
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(await storage.headObject(bucket, key)).toBe(body.length);
      await storage.deleteObject(bucket, key);
      expect(await storage.headObject(bucket, key)).toBeNull();
    });

    it('should delete every object under a prefix and keep the others', async () => {
      // Arrange
      const body = Buffer.from('x');
      await storage.putObject(bucket, 'thumbs/v1/a.jpg', body, 'image/jpeg');
      await storage.putObject(bucket, 'thumbs/v1/b.jpg', body, 'image/jpeg');
      await storage.putObject(bucket, 'thumbs/v2/a.jpg', body, 'image/jpeg');

      // Act
      await storage.deletePrefix(bucket, 'thumbs/v1/');

      // Assert
      expect(await storage.headObject(bucket, 'thumbs/v1/a.jpg')).toBeNull();
      expect(await storage.headObject(bucket, 'thumbs/v1/b.jpg')).toBeNull();
      expect(await storage.headObject(bucket, 'thumbs/v2/a.jpg')).toBe(1);
    });
  });

  describe('presigned GET', () => {
    const key = 'videos/range/original';
    const body = Buffer.alloc(1000, 7);

    beforeEach(async () => {
      await storage.putObject(bucket, key, body, 'video/mp4');
    });

    it('should answer a Range request with 206 and Content-Range', async () => {
      const url = await storage.presignGet(bucket, key);

      const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 0-99/1000');
      expect((await res.arrayBuffer()).byteLength).toBe(100);
    });

    it('should return the requested Content-Disposition override', async () => {
      const url = await storage.presignGet(bucket, key, {
        responseContentDisposition: 'attachment; filename="clip.mp4"',
      });

      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="clip.mp4"',
      );
    });

    it('should serve the object through the internal presigned URL', async () => {
      const url = await storage.presignInternalGet(bucket, key);

      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(body.length);
    });
  });

  describe('URL hosts (default config, offline signing)', () => {
    let defaultModule: TestingModule;
    let defaultStorage: StorageService;
    const publicHost = new URL(storageConfig().publicEndpoint).host;
    const internalHost = new URL(storageConfig().endpoint).host;

    beforeAll(async () => {
      defaultModule = await compileStorage();
      defaultStorage = defaultModule.get(StorageService);
    });

    afterAll(async () => {
      await defaultModule.close();
    });

    it('should sign part and GET URLs for S3_PUBLIC_ENDPOINT without CRC32 checksum params', async () => {
      const urls = [
        await defaultStorage.presignUploadPart(bucket, 'k', 'upload-id', 1),
        await defaultStorage.presignGet(bucket, 'k'),
      ];

      for (const url of urls) {
        expect(new URL(url).host).toBe(publicHost);
        expect(url.toLowerCase()).not.toContain('checksum');
        expect(url.toLowerCase()).not.toContain('crc32');
      }
    });

    it('should sign internal GET URLs for S3_ENDPOINT', async () => {
      const url = await defaultStorage.presignInternalGet(bucket, 'k');

      expect(new URL(url).host).toBe(internalHost);
    });

    it('should build path-style public object URLs over S3_PUBLIC_ENDPOINT', () => {
      const url = defaultStorage.getPublicObjectUrl(
        'thumbnails',
        'abc/default.jpg',
      );

      expect(url).toBe(
        `${storageConfig().publicEndpoint.replace(/\/+$/, '')}/thumbnails/abc/default.jpg`,
      );
    });
  });
});
