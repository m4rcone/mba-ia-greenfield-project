import type { S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, registerAs } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createMinioTestClient,
  createTestBucket,
  deleteTestBucket,
  testBucketName,
} from '../test/minio';
import {
  obliterateTestQueue,
  testQueuePrefix,
  testRedisConfig,
} from '../test/redis';
import { User } from '../users/entities/user.entity';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import {
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MIB = 1024 * 1024;

describe('VideosService (integration)', () => {
  const bucket = testBucketName('videos-svc');
  let s3: S3Client;
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storageService: StorageService;
  let videoRepository: Repository<Video>;
  let queue: Queue;

  beforeAll(async () => {
    s3 = createMinioTestClient();
    await createTestBucket(s3, bucket);

    // Presigned URLs are fetched from inside the container, so sign them for the
    // internal endpoint (SigV4 binds the Host header).
    const testStorageConfig = registerAs('storage', () => {
      const base = storageConfig();
      return {
        ...base,
        publicEndpoint: base.endpoint,
        buckets: { ...base.buckets, videos: bucket },
      };
    });
    const ds = createTestDataSource(ALL_ENTITIES);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            testStorageConfig,
            testRedisConfig(testQueuePrefix()),
            uploadConfig,
          ],
        }),
        TypeOrmModule.forRoot(ds.options),
        VideosModule,
      ],
    }).compile();

    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storageService = module.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await obliterateTestQueue(queue);
    await module.close();
    await deleteTestBucket(s3, bucket);
    s3.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<User> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `video_svc_${n}@example.com`,
      password: 'hashed',
    });
    await dataSource.getRepository(Channel).save({
      name: `Channel ${n}`,
      nickname: `videosvc${n}`,
      user_id: user.id,
    });
    return user;
  }

  async function uploadPart(
    videoId: string,
    userId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<void> {
    const { parts } = await service.presignParts(videoId, userId, [partNumber]);
    const response = await fetch(parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(200);
  }

  function originalKey(videoId: string): string {
    return `videos/${videoId}/original`;
  }

  describe('initiateUpload', () => {
    it('should persist a 10 GiB draft with 16 MiB parts and an open multipart upload', async () => {
      const user = await createUserWithChannel();

      const video = await service.initiateUpload(user.id, {
        fileName: 'movie.mp4',
        contentType: 'video/mp4',
        fileSize: 10737418240,
      });

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row).toMatchObject({
        title: 'movie',
        status: 'draft',
        processing_status: VideoProcessingStatus.UPLOADING,
        size_bytes: 10737418240,
        part_size: 16777216,
        part_count: 640,
      });
      // A valid UploadId lists (zero) parts instead of failing with NoSuchUpload.
      await expect(
        storageService.listParts(bucket, originalKey(video.id), row.upload_id!),
      ).resolves.toEqual([]);
    });

    it('should leave no row when CreateMultipartUpload fails', async () => {
      const user = await createUserWithChannel();
      jest
        .spyOn(storageService, 'createMultipartUpload')
        .mockRejectedValueOnce(new Error('storage down'));

      await expect(
        service.initiateUpload(user.id, {
          fileName: 'movie.mp4',
          contentType: 'video/mp4',
          fileSize: 1024,
        }),
      ).rejects.toThrow('storage down');
      expect(await videoRepository.count()).toBe(0);
    });
  });

  describe('listUploadedParts', () => {
    it('should report the parts already stored for resuming', async () => {
      const user = await createUserWithChannel();
      const video = await service.initiateUpload(user.id, {
        fileName: 'clip.webm',
        contentType: 'video/webm',
        fileSize: 16 * MIB + 10,
      });
      await uploadPart(video.id, user.id, 2, Buffer.alloc(10));

      const progress = await service.listUploadedParts(video.id, user.id);

      expect(progress).toEqual({
        partSize: 16 * MIB,
        partCount: 2,
        uploadedParts: [{ partNumber: 2, size: 10 }],
      });
    });
  });

  describe('completeUpload', () => {
    it('should complete, move the video to processing and enqueue process-video', async () => {
      const user = await createUserWithChannel();
      const body = Buffer.alloc(1024, 1);
      const video = await service.initiateUpload(user.id, {
        fileName: 'clip.mp4',
        contentType: 'video/mp4',
        fileSize: body.length,
      });
      await uploadPart(video.id, user.id, 1, body);

      await service.completeUpload(video.id, user.id);

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.processing_status).toBe(VideoProcessingStatus.PROCESSING);
      expect(row.upload_id).toBeNull();
      expect(
        await storageService.headObject(bucket, originalKey(video.id)),
      ).toBe(body.length);
      const job = await queue.getJob(video.id);
      expect(job?.data).toEqual({ videoId: video.id });
    });

    it('should delete the object and mark the video failed when the stored size differs', async () => {
      const user = await createUserWithChannel();
      const video = await service.initiateUpload(user.id, {
        fileName: 'clip.mp4',
        contentType: 'video/mp4',
        fileSize: 2048,
      });
      await uploadPart(video.id, user.id, 1, Buffer.alloc(1024));

      await expect(
        service.completeUpload(video.id, user.id),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row).toMatchObject({
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: 'UPLOAD_SIZE_MISMATCH',
        upload_id: null,
      });
      expect(
        await storageService.headObject(bucket, originalKey(video.id)),
      ).toBeNull();
      expect(await queue.getJob(video.id)).toBeUndefined();
    });

    it('should throw UPLOAD_INCOMPLETE and keep the video uploading when a part is missing', async () => {
      const user = await createUserWithChannel();
      const video = await service.initiateUpload(user.id, {
        fileName: 'clip.mp4',
        contentType: 'video/mp4',
        fileSize: 16 * MIB + 1,
      });
      await uploadPart(video.id, user.id, 1, Buffer.alloc(1));

      await expect(
        service.completeUpload(video.id, user.id),
      ).rejects.toBeInstanceOf(UploadIncompleteException);

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.processing_status).toBe(VideoProcessingStatus.UPLOADING);
      expect(row.upload_id).toBe(video.upload_id);
    });
  });

  describe('cancelUpload', () => {
    it('should abort the multipart upload and mark the video failed with UPLOAD_CANCELLED', async () => {
      const user = await createUserWithChannel();
      const video = await service.initiateUpload(user.id, {
        fileName: 'clip.mov',
        contentType: 'video/quicktime',
        fileSize: 1024,
      });
      const uploadId = video.upload_id!;

      await service.cancelUpload(video.id, user.id);

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row).toMatchObject({
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: 'UPLOAD_CANCELLED',
        upload_id: null,
      });
      await expect(
        storageService.listParts(bucket, originalKey(video.id), uploadId),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    });
  });

  describe('owner-only access', () => {
    it('should throw VIDEO_NOT_FOUND to another user on every upload operation', async () => {
      const owner = await createUserWithChannel();
      const intruder = await createUserWithChannel();
      const video = await service.initiateUpload(owner.id, {
        fileName: 'clip.mp4',
        contentType: 'video/mp4',
        fileSize: 1024,
      });

      await expect(
        service.presignParts(video.id, intruder.id, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.listUploadedParts(video.id, intruder.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.completeUpload(video.id, intruder.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.cancelUpload(video.id, intruder.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.processing_status).toBe(VideoProcessingStatus.UPLOADING);
    });
  });

  describe('getPlaybackUrl', () => {
    async function createReadyVideo(
      userId: string,
      fileName: string,
      bytes: number,
    ): Promise<Video> {
      const video = await service.initiateUpload(userId, {
        fileName,
        contentType: 'video/mp4',
        fileSize: bytes,
      });
      await uploadPart(video.id, userId, 1, Buffer.alloc(bytes, 7));
      await service.completeUpload(video.id, userId);
      // The worker does not run here; promote the row the way it would.
      await videoRepository.update(
        { id: video.id },
        { processing_status: VideoProcessingStatus.READY },
      );
      return video;
    }

    it('should return a stream URL that storage serves with 206 for a Range request', async () => {
      const user = await createUserWithChannel();
      const video = await createReadyVideo(user.id, 'clip.mp4', 2048);

      const url = await service.getPlaybackUrl(
        video.public_id,
        user.id,
        'stream',
      );
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-1023/2048');
      expect(response.headers.get('content-type')).toBe('video/mp4');
      expect((await response.arrayBuffer()).byteLength).toBe(1024);
    });

    it('should return a download URL that storage serves as an attachment with the original name', async () => {
      const user = await createUserWithChannel();
      const video = await createReadyVideo(user.id, 'férias.mp4', 1024);

      const url = await service.getPlaybackUrl(
        video.public_id,
        user.id,
        'download',
      );
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        "attachment; filename*=UTF-8''f%C3%A9rias.mp4",
      );
    });
  });
});
