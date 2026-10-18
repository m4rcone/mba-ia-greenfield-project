import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  VIDEO_PROCESSING_JOBS,
  VIDEO_PROCESSING_QUEUE,
} from '../../queue/queue.constants';
import {
  CLEANUP_STALE_UPLOADS_CRON,
  CLEANUP_STALE_UPLOADS_JOB_OPTIONS,
} from './reconciler.constants';

/** Registers the reconciler schedule on worker boot; upsert keeps exactly one (TD-11). */
@Injectable()
export class ReconcilerScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      VIDEO_PROCESSING_JOBS.CLEANUP_STALE_UPLOADS,
      { pattern: CLEANUP_STALE_UPLOADS_CRON },
      {
        name: VIDEO_PROCESSING_JOBS.CLEANUP_STALE_UPLOADS,
        data: {},
        opts: CLEANUP_STALE_UPLOADS_JOB_OPTIONS,
      },
    );
  }
}
