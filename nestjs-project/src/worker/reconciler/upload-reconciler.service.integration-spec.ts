import {
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { type Queue, UnrecoverableError, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import redisConfig from '../../config/redis.config';
import {
  VIDEO_PROCESSING_JOBS,
  VIDEO_PROCESSING_QUEUE,
} from '../../queue/queue.constants';
import { VideoProcessingProducer } from '../../queue/video-processing.producer';
import { StorageService } from '../../storage/storage.service';
import { cleanAllTables } from '../../test/create-test-data-source';
import {
  createMinioTestClient,
  createTestBucket,
  deleteTestBucket,
  testBucketName,
} from '../../test/minio';
import { obliterateTestQueue, testQueuePrefix } from '../../test/redis';
import { User } from '../../users/entities/user.entity';
import {
  Video,
  VideoProcessingStatus,
} from '../../videos/entities/video.entity';
import { WorkerModule } from '../worker.module';
import { ReconcilerScheduler } from './reconciler.scheduler';
import { UploadReconcilerService } from './upload-reconciler.service';

describe('UploadReconcilerService (integration)', () => {
  const videosBucket = testBucketName('reconciler-videos');
  const thumbnailsBucket = testBucketName('reconciler-thumbs');
  const queuePrefix = testQueuePrefix();
  const overriddenEnv = {
    BULLMQ_PREFIX: queuePrefix,
    S3_BUCKET_VIDEOS: videosBucket,
    S3_BUCKET_THUMBNAILS: thumbnailsBucket,
  };
  const previousEnv: Record<string, string | undefined> = {};
  let s3: S3Client;
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let reconciler: UploadReconcilerService;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(overriddenEnv)) {
      previousEnv[key] = process.env[key];
      process.env[key] = value;
    }
    s3 = createMinioTestClient();
    await createTestBucket(s3, videosBucket);
    await createTestBucket(s3, thumbnailsBucket);

    // Compiled but not initialised: no BullMQ worker consumes the jobs under test.
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    reconciler = module.get(UploadReconcilerService);
  });

  afterAll(async () => {
    await obliterateTestQueue(queue);
    await module.close();
    await deleteTestBucket(s3, videosBucket);
    await deleteTestBucket(s3, thumbnailsBucket);
    s3.destroy();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await obliterateTestQueue(queue);
  });

  let counter = 0;
  async function seedVideo(
    status: VideoProcessingStatus,
    {
      id = randomUUID(),
      ageMinutes = 0,
      uploadId = null as string | null,
    } = {},
  ): Promise<Video> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `reconciler_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `Channel ${n}`,
      nickname: `reconchan${n}`,
      user_id: user.id,
    });
    const video = await videoRepository.save(
      videoRepository.create({
        id,
        public_id: `rec${String(n).padStart(8, '0')}`,
        channel_id: channel.id,
        title: `Video ${n}`,
        processing_status: status,
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        upload_id: uploadId,
        part_size: 16 * 1024 * 1024,
        part_count: 1,
      }),
    );
    if (ageMinutes > 0) {
      await dataSource.query(
        `UPDATE videos SET updated_at = now() - make_interval(mins => $2) WHERE id = $1`,
        [video.id, ageMinutes],
      );
    }
    return videoRepository.findOneByOrFail({ id: video.id });
  }

  async function seedAbandonedUpload(ageMinutes: number): Promise<Video> {
    const id = randomUUID();
    const uploadId = await module
      .get(StorageService)
      .createMultipartUpload(
        videosBucket,
        `videos/${id}/original`,
        'video/mp4',
      );
    return seedVideo(VideoProcessingStatus.UPLOADING, {
      id,
      ageMinutes,
      uploadId,
    });
  }

  async function putOriginal(videoId: string): Promise<void> {
    await s3.send(
      new PutObjectCommand({
        Bucket: videosBucket,
        Key: `videos/${videoId}/original`,
        Body: Buffer.from('original'),
      }),
    );
  }

  async function originalExists(videoId: string): Promise<boolean> {
    return s3
      .send(
        new HeadObjectCommand({
          Bucket: videosBucket,
          Key: `videos/${videoId}/original`,
        }),
      )
      .then(
        () => true,
        () => false,
      );
  }

  async function openUploadIds(): Promise<string[]> {
    const { Uploads } = await s3.send(
      new ListMultipartUploadsCommand({ Bucket: videosBucket }),
    );
    return (Uploads ?? []).map((upload) => upload.UploadId!);
  }

  /** Drives a real job to the `failed` state with a throwaway worker. */
  async function failJobFor(videoId: string): Promise<void> {
    const { host, port } = redisConfig();
    const worker = new Worker(
      VIDEO_PROCESSING_QUEUE,
      () => Promise.reject(new UnrecoverableError('ffmpeg crashed')),
      { connection: { host, port }, prefix: queuePrefix },
    );
    const failed = new Promise<void>((resolve) =>
      worker.on('failed', () => resolve()),
    );
    await module.get(VideoProcessingProducer).enqueueProcessVideo(videoId);
    await failed;
    await worker.close();
  }

  it('should abort an abandoned multipart and mark the video UPLOAD_ABANDONED', async () => {
    const stale = await seedAbandonedUpload(25 * 60);
    const fresh = await seedVideo(VideoProcessingStatus.UPLOADING, {
      uploadId: 'still-in-progress',
    });

    await reconciler.run();

    const row = await videoRepository.findOneByOrFail({ id: stale.id });
    expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(row.processing_error).toBe('UPLOAD_ABANDONED');
    expect(row.upload_id).toBeNull();
    expect(await openUploadIds()).not.toContain(stale.upload_id);
    const untouched = await videoRepository.findOneByOrFail({ id: fresh.id });
    expect(untouched.processing_status).toBe(VideoProcessingStatus.UPLOADING);
  });

  it('should re-enqueue process-video for a stuck video with no job', async () => {
    const video = await seedVideo(VideoProcessingStatus.PROCESSING, {
      ageMinutes: 90,
    });

    await reconciler.run();

    const job = await queue.getJob(video.id);
    expect(job?.name).toBe(VIDEO_PROCESSING_JOBS.PROCESS_VIDEO);
    expect(job?.data).toEqual({ videoId: video.id });
    expect(await job?.getState()).toBe('waiting');
  });

  it('should mark a stuck video PROCESSING_FAILED when its job already failed', async () => {
    const video = await seedVideo(VideoProcessingStatus.PROCESSING, {
      ageMinutes: 90,
    });
    await failJobFor(video.id);

    await reconciler.run();

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(row.processing_error).toBe('PROCESSING_FAILED');
  });

  it('should leave a stuck video untouched while its job is waiting', async () => {
    const video = await seedVideo(VideoProcessingStatus.PROCESSING, {
      ageMinutes: 90,
    });
    await module.get(VideoProcessingProducer).enqueueProcessVideo(video.id);
    const before = await queue.getJob(video.id);

    await reconciler.run();

    expect(await videoRepository.findOneByOrFail({ id: video.id })).toEqual(
      video,
    );
    const after = await queue.getJob(video.id);
    expect(after?.timestamp).toBe(before?.timestamp);
    expect(await after?.getState()).toBe('waiting');
  });

  it('should delete the leftover original of a failed video', async () => {
    const video = await seedVideo(VideoProcessingStatus.FAILED);
    await putOriginal(video.id);

    await reconciler.run();

    expect(await originalExists(video.id)).toBe(false);
  });

  it('should have no further effect when run twice in a row', async () => {
    await seedAbandonedUpload(25 * 60);
    await seedVideo(VideoProcessingStatus.PROCESSING, { ageMinutes: 90 });
    const failed = await seedVideo(VideoProcessingStatus.FAILED);
    await putOriginal(failed.id);

    const first = await reconciler.run();
    const rowsAfterFirst = await videoRepository.find({ order: { id: 'ASC' } });
    const second = await reconciler.run();

    expect(first).toEqual({
      abandonedUploads: 1,
      requeued: 1,
      failedStuck: 0,
      deletedOriginals: 1,
    });
    expect(second).toEqual({
      abandonedUploads: 0,
      requeued: 0,
      failedStuck: 0,
      deletedOriginals: 0,
    });
    expect(await videoRepository.find({ order: { id: 'ASC' } })).toEqual(
      rowsAfterFirst,
    );
    expect(await queue.getJobCountByTypes('waiting')).toBe(1);
  });

  it('should keep exactly one cleanup-stale-uploads scheduler across worker restarts', async () => {
    const scheduler = module.get(ReconcilerScheduler);

    await scheduler.onApplicationBootstrap();
    await scheduler.onApplicationBootstrap();

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: VIDEO_PROCESSING_JOBS.CLEANUP_STALE_UPLOADS,
      name: VIDEO_PROCESSING_JOBS.CLEANUP_STALE_UPLOADS,
    });
  });
});
