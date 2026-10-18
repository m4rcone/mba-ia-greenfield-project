import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import {
  obliterateTestQueue,
  testQueuePrefix,
  testRedisConfig,
} from '../test/redis';
import {
  VIDEO_PROCESSING_JOBS,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';
import { QueueModule } from './queue.module';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [testRedisConfig(testQueuePrefix())],
        }),
        QueueModule,
      ],
    }).compile();
    producer = module.get(VideoProcessingProducer);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterEach(async () => {
    await obliterateTestQueue(queue);
  });

  afterAll(async () => {
    await module.close();
  });

  it('should enqueue process-video with jobId = videoId, the payload and retry options', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessVideo(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(VIDEO_PROCESSING_JOBS.PROCESS_VIDEO);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { age: expect.any(Number) as number },
      removeOnFail: { age: expect.any(Number) as number },
    });
  });

  it('should not duplicate the job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessVideo(videoId);
    await producer.enqueueProcessVideo(videoId);

    const jobs = await queue.getJobs(['waiting', 'active', 'delayed']);
    expect(jobs.map((j) => j.id)).toEqual([videoId]);
  });

  it('should leave the job waiting because the API side registers no processor', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessVideo(videoId);

    const job = await queue.getJob(videoId);
    expect(await job!.getState()).toBe('waiting');
  });
});
