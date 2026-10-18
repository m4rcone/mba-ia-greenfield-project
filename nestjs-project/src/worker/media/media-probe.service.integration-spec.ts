import type { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { MEDIA_FIXTURES, uploadMediaFixture } from '../../test/media-fixtures';
import {
  createMinioTestClient,
  createTestBucket,
  deleteTestBucket,
  testBucketName,
} from '../../test/minio';
import { MediaProbeService } from './media-probe.service';
import { MediaValidationError } from './media-validation.error';

describe('MediaProbeService (integration)', () => {
  const bucket = testBucketName('media-probe');
  let s3: S3Client;
  let module: TestingModule;
  let storage: StorageService;
  let service: MediaProbeService;

  beforeAll(async () => {
    s3 = createMinioTestClient();
    await createTestBucket(s3, bucket);
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [MediaProbeService],
    }).compile();
    storage = module.get(StorageService);
    service = module.get(MediaProbeService);
  });

  afterAll(async () => {
    await module.close();
    await deleteTestBucket(s3, bucket);
    s3.destroy();
  });

  async function fixtureUrl(fileName: string): Promise<string> {
    const key = await uploadMediaFixture(s3, bucket, fileName);
    return storage.presignInternalGet(bucket, key);
  }

  async function probeError(fileName: string): Promise<unknown> {
    const url = await fixtureUrl(fileName);
    return service.probeAndValidate(url).then(
      () => {
        throw new Error(`${fileName} was accepted`);
      },
      (err: unknown) => err,
    );
  }

  it('should extract duration, dimensions and codecs from a valid h264/aac mp4', async () => {
    const metadata = await service.probeAndValidate(
      await fixtureUrl(MEDIA_FIXTURES.VALID_H264_AAC_MP4),
    );

    expect(metadata).toEqual({
      durationSeconds: expect.closeTo(2, 1) as number,
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
  });

  it('should accept a valid vp9/opus webm', async () => {
    const metadata = await service.probeAndValidate(
      await fixtureUrl(MEDIA_FIXTURES.VALID_VP9_OPUS_WEBM),
    );

    expect(metadata).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'vp9',
      audioCodec: 'opus',
    });
    expect(metadata.durationSeconds).toBeGreaterThan(0);
  });

  it('should reject a PNG renamed to .mp4 as NOT_A_VIDEO', async () => {
    const err = await probeError(MEDIA_FIXTURES.PNG_RENAMED_MP4);

    expect(err).toBeInstanceOf(MediaValidationError);
    expect((err as MediaValidationError).code).toBe('NOT_A_VIDEO');
  });

  it('should reject a truncated mp4 as CORRUPT_MEDIA', async () => {
    const err = await probeError(MEDIA_FIXTURES.TRUNCATED_MP4);

    expect(err).toBeInstanceOf(MediaValidationError);
    expect((err as MediaValidationError).code).toBe('CORRUPT_MEDIA');
  });

  it('should reject a codec outside the allowlist as UNSUPPORTED_CODEC', async () => {
    const err = await probeError(MEDIA_FIXTURES.UNSUPPORTED_CODEC_MKV);

    expect(err).toBeInstanceOf(MediaValidationError);
    expect((err as MediaValidationError).code).toBe('UNSUPPORTED_CODEC');
  });

  it('should raise a transient error, not a MediaValidationError, for an unreachable URL', async () => {
    const url = await storage.presignInternalGet(
      bucket,
      'fixtures/missing.mp4',
    );

    const err = await service.probeAndValidate(url).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MediaValidationError);
  });
});
