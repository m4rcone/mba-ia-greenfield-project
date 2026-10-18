import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_JOBS,
  VIDEO_PROCESSING_QUEUE,
} from '../../queue/queue.constants';
import { VideoProcessingProducer } from '../../queue/video-processing.producer';
import { cleanAllTables } from '../../test/create-test-data-source';
import { MEDIA_FIXTURES } from '../../test/media-fixtures';
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
import { MediaProbeService } from '../media/media-probe.service';
import { WorkerModule } from '../worker.module';
import { VideoProcessingService } from './video-processing.service';

const FIXTURES_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'media',
);

async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting; last value: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('VideoProcessor (integration)', () => {
  const videosBucket = testBucketName('worker-videos');
  const thumbnailsBucket = testBucketName('worker-thumbs');
  const overriddenEnv = {
    BULLMQ_PREFIX: testQueuePrefix(),
    S3_BUCKET_VIDEOS: videosBucket,
    S3_BUCKET_THUMBNAILS: thumbnailsBucket,
  };
  const previousEnv: Record<string, string | undefined> = {};
  let s3: S3Client;
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let producer: VideoProcessingProducer;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(overriddenEnv)) {
      previousEnv[key] = process.env[key];
      process.env[key] = value;
    }
    s3 = createMinioTestClient();
    await createTestBucket(s3, videosBucket);
    await createTestBucket(s3, thumbnailsBucket);

    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await module.init(); // starts the BullMQ worker behind VideoProcessor

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    producer = module.get(VideoProcessingProducer);
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
    jest.restoreAllMocks();
  });

  let counter = 0;
  /** A video the API just completed: row in `processing` + original object in storage. */
  async function seedCompletedUpload(
    fixture: string,
    status = VideoProcessingStatus.PROCESSING,
  ): Promise<Video> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `worker_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `Channel ${n}`,
      nickname: `workerchan${n}`,
      user_id: user.id,
    });
    const body = readFileSync(join(FIXTURES_DIR, fixture));
    const video = await videoRepository.save(
      videoRepository.create({
        id: randomUUID(),
        public_id: `wrk${String(n).padStart(8, '0')}`,
        channel_id: channel.id,
        title: fixture,
        processing_status: status,
        original_filename: fixture,
        content_type: 'video/mp4',
        size_bytes: body.length,
        upload_id: null,
        part_size: 16 * 1024 * 1024,
        part_count: 1,
      }),
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: videosBucket,
        Key: `videos/${video.id}/original`,
        Body: body,
      }),
    );
    return video;
  }

  function waitForProcessingStatus(id: string, status: VideoProcessingStatus) {
    return waitFor(
      () => videoRepository.findOneByOrFail({ id }),
      (row) => row.processing_status === status,
    );
  }

  async function waitForJobState(id: string, states: string[]) {
    return waitFor(
      async () => (await queue.getJob(id))?.getState(),
      (state) => state !== undefined && states.includes(state),
    );
  }

  async function objectExists(bucket: string, key: string): Promise<boolean> {
    return s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(
      () => true,
      () => false,
    );
  }

  async function countThumbnails(videoId: string): Promise<number> {
    const { KeyCount } = await s3.send(
      new ListObjectsV2Command({
        Bucket: thumbnailsBucket,
        Prefix: `thumbnails/${videoId}/`,
      }),
    );
    return KeyCount ?? 0;
  }

  it('should take a valid mp4 to ready with metadata and a JPEG thumbnail', async () => {
    const video = await seedCompletedUpload(MEDIA_FIXTURES.VALID_H264_AAC_MP4);

    await producer.enqueueProcessVideo(video.id);
    const row = await waitForProcessingStatus(
      video.id,
      VideoProcessingStatus.READY,
    );

    expect(row).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      processing_error: null,
      thumbnail_key: `thumbnails/${video.id}/default.jpg`,
    });
    expect(row.duration_seconds).toBeCloseTo(2, 1);
    const thumbnail = await s3.send(
      new HeadObjectCommand({
        Bucket: thumbnailsBucket,
        Key: `thumbnails/${video.id}/default.jpg`,
      }),
    );
    expect(thumbnail.ContentType).toBe('image/jpeg');
  });

  it('should not add a second thumbnail nor touch a ready video when reprocessed', async () => {
    const video = await seedCompletedUpload(MEDIA_FIXTURES.SHORT_H264_MP4);
    await producer.enqueueProcessVideo(video.id);
    const ready = await waitForProcessingStatus(
      video.id,
      VideoProcessingStatus.READY,
    );

    await module.get(VideoProcessingService).process(video.id);

    const after = await videoRepository.findOneByOrFail({ id: video.id });
    expect(after.updated_at).toEqual(ready.updated_at);
    expect(after.processing_status).toBe(VideoProcessingStatus.READY);
    expect(await countThumbnails(video.id)).toBe(1);
  });

  it('should fail a non-video after a single attempt with NOT_A_VIDEO and remove the original', async () => {
    const video = await seedCompletedUpload(MEDIA_FIXTURES.PNG_RENAMED_MP4);

    await producer.enqueueProcessVideo(video.id);
    const row = await waitForProcessingStatus(
      video.id,
      VideoProcessingStatus.FAILED,
    );

    expect(row.processing_error).toBe('NOT_A_VIDEO');
    const job = await queue.getJob(video.id);
    expect(job?.attemptsMade).toBe(1);
    await waitFor(
      () => objectExists(videosBucket, `videos/${video.id}/original`),
      (exists) => !exists,
    );
    expect(await countThumbnails(video.id)).toBe(0);
  });

  it('should mark PROCESSING_FAILED only after all 3 attempts of a persistent transient failure', async () => {
    const video = await seedCompletedUpload(MEDIA_FIXTURES.VALID_H264_AAC_MP4);
    const probe = jest
      .spyOn(module.get(MediaProbeService), 'probeAndValidate')
      .mockRejectedValue(new Error('ffprobe failed: Server returned 503'));

    // Same options as the producer, with a short backoff so the test stays fast.
    await queue.add(
      VIDEO_PROCESSING_JOBS.PROCESS_VIDEO,
      { videoId: video.id },
      {
        ...PROCESS_VIDEO_JOB_OPTIONS,
        jobId: video.id,
        backoff: { type: 'fixed', delay: 50 },
      },
    );
    await waitForJobState(video.id, ['failed']);
    const row = await waitForProcessingStatus(
      video.id,
      VideoProcessingStatus.FAILED,
    );

    expect(row.processing_error).toBe('PROCESSING_FAILED');
    expect((await queue.getJob(video.id))?.attemptsMade).toBe(3);
    expect(probe).toHaveBeenCalledTimes(3);
    // Not a media failure: the original stays for a later retry/sweep.
    expect(
      await objectExists(videosBucket, `videos/${video.id}/original`),
    ).toBe(true);
  });

  it('should never overwrite a video that is not processing', async () => {
    const video = await seedCompletedUpload(
      MEDIA_FIXTURES.VALID_H264_AAC_MP4,
      VideoProcessingStatus.FAILED,
    );

    await producer.enqueueProcessVideo(video.id);
    await waitForJobState(video.id, ['completed']);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(row.thumbnail_key).toBeNull();
    expect(await countThumbnails(video.id)).toBe(0);
  });
});
