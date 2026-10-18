import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB_OPTIONS,
  type ProcessVideoJobData,
  VIDEO_PROCESSING_JOBS,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  // jobId = videoId: BullMQ ignores the add while a job with that id is retained (TD-06).
  async enqueueProcessVideo(videoId: string): Promise<void> {
    await this.queue.add(
      VIDEO_PROCESSING_JOBS.PROCESS_VIDEO,
      { videoId },
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId },
    );
  }
}
