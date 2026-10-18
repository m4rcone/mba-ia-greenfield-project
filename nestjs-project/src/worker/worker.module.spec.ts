import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { testQueuePrefix } from '../test/redis';
import { Video } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  const previousPrefix = process.env.BULLMQ_PREFIX;

  beforeAll(() => {
    // Keep the compiled module off the dev queue keys.
    process.env.BULLMQ_PREFIX = testQueuePrefix();
  });

  afterAll(() => {
    if (previousPrefix === undefined) delete process.env.BULLMQ_PREFIX;
    else process.env.BULLMQ_PREFIX = previousPrefix;
  });

  it('should compile with validated config, the Video repository, Storage and Queue', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(getRepositoryToken(Video))).toBeDefined();
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue.opts.prefix).toBe(process.env.BULLMQ_PREFIX);
    await module.close();
  }, 30000);
});
