import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import {
  type ProcessVideoJobData,
  VIDEO_PROCESSING_JOBS,
  VIDEO_PROCESSING_QUEUE,
} from '../../queue/queue.constants';
import { UploadReconcilerService } from '../reconciler/upload-reconciler.service';
import { VideoProcessingService } from './video-processing.service';

/** The single consumer of the queue; dispatches by job name (TD-01). Worker-only. */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly videoProcessingService: VideoProcessingService,
    private readonly uploadReconcilerService: UploadReconcilerService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case VIDEO_PROCESSING_JOBS.PROCESS_VIDEO:
        await this.videoProcessingService.process(
          (job.data as ProcessVideoJobData).videoId,
        );
        return;
      case VIDEO_PROCESSING_JOBS.CLEANUP_STALE_UPLOADS:
        await this.uploadReconcilerService.run();
        return;
      default:
        throw new UnrecoverableError(`Unknown job name: ${job.name}`);
    }
  }

  /** Fires after every failed attempt; only the last one marks the video failed. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, err: Error): Promise<void> {
    if (job?.name !== VIDEO_PROCESSING_JOBS.PROCESS_VIDEO) {
      return;
    }
    const isFinal =
      err instanceof UnrecoverableError ||
      job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!isFinal) {
      this.logger.warn(
        `process-video ${job.id} attempt ${job.attemptsMade} failed, retrying: ${err.message}`,
      );
      return;
    }
    await this.videoProcessingService.markFailed(
      (job.data as ProcessVideoJobData).videoId,
      err,
    );
  }
}
