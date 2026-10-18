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
import { ThumbnailService } from './thumbnail.service';

const JPEG_SOI = [0xff, 0xd8];
const JPEG_EOI = [0xff, 0xd9];

describe('ThumbnailService (integration)', () => {
  const bucket = testBucketName('thumbnail');
  let s3: S3Client;
  let module: TestingModule;
  let storage: StorageService;
  let service: ThumbnailService;

  beforeAll(async () => {
    s3 = createMinioTestClient();
    await createTestBucket(s3, bucket);
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [ThumbnailService],
    }).compile();
    storage = module.get(StorageService);
    service = module.get(ThumbnailService);
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

  function expectJpeg(frame: Buffer): void {
    expect([...frame.subarray(0, 2)]).toEqual(JPEG_SOI);
    expect([...frame.subarray(-2)]).toEqual(JPEG_EOI);
  }

  it('should extract a JPEG frame from a video shorter than 1 s', async () => {
    const frame = await service.extractFrame(
      await fixtureUrl(MEDIA_FIXTURES.SHORT_H264_MP4),
      0.52,
    );

    expectJpeg(frame);
  });

  it('should extract a JPEG frame at 1 s from a longer video', async () => {
    const frame = await service.extractFrame(
      await fixtureUrl(MEDIA_FIXTURES.VALID_H264_AAC_MP4),
      2,
    );

    expectJpeg(frame);
  });

  it('should extract a JPEG frame from a webm', async () => {
    const frame = await service.extractFrame(
      await fixtureUrl(MEDIA_FIXTURES.VALID_VP9_OPUS_WEBM),
      1.008,
    );

    expectJpeg(frame);
  });
});
