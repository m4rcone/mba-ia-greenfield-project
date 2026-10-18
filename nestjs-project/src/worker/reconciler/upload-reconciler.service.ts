import { NoSuchUpload } from '@aws-sdk/client-s3';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { LessThan, Repository } from 'typeorm';
import storageConfig from '../../config/storage.config';
import uploadConfig from '../../config/upload.config';
import {
  type ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../../queue/queue.constants';
import { VideoProcessingProducer } from '../../queue/video-processing.producer';
import { StorageService } from '../../storage/storage.service';
import {
  Video,
  VideoProcessingStatus,
} from '../../videos/entities/video.entity';
import {
  VIDEO_PROCESSING_ERRORS,
  originalObjectKey,
} from '../../videos/videos.constants';

export interface ReconcileSummary {
  abandonedUploads: number;
  requeued: number;
  failedStuck: number;
  deletedOriginals: number;
}

/**
 * Body of the scheduled `cleanup-stale-uploads` job (TD-11). Every step is conditional
 * or idempotent, so a duplicate or repeated run has no further effect.
 */
@Injectable()
export class UploadReconcilerService {
  private readonly logger = new Logger(UploadReconcilerService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
    private readonly videoProcessingProducer: VideoProcessingProducer,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
  ) {}

  async run(): Promise<ReconcileSummary> {
    const abandonedUploads = await this.abandonStaleUploads();
    const { requeued, failedStuck } = await this.recoverStuckProcessing();
    const deletedOriginals = await this.deleteLeftoverOriginals();
    const summary = {
      abandonedUploads,
      requeued,
      failedStuck,
      deletedOriginals,
    };
    this.logger.log(`Reconciled: ${JSON.stringify(summary)}`);
    return summary;
  }

  /** Step 1: `uploading` past UPLOAD_ABANDON_AFTER_HOURS → abort multipart + failed. */
  private async abandonStaleUploads(): Promise<number> {
    const stale = await this.videoRepository.findBy({
      processing_status: VideoProcessingStatus.UPLOADING,
      updated_at: LessThan(
        this.ago(this.upload.abandonAfterHours * 60 * 60 * 1000),
      ),
    });

    let abandoned = 0;
    await this.forEachIsolated(stale, async (video) => {
      if (video.upload_id) {
        await this.abortIgnoringMissing(video.id, video.upload_id);
      }
      const { affected } = await this.videoRepository.update(
        { id: video.id, processing_status: VideoProcessingStatus.UPLOADING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          processing_error: VIDEO_PROCESSING_ERRORS.UPLOAD_ABANDONED,
          upload_id: null,
        },
      );
      abandoned += affected ?? 0;
    });
    return abandoned;
  }

  /**
   * Step 2: `processing` past PROCESSING_STUCK_AFTER_MINUTES. BullMQ ignores `add()` while a
   * job with the same jobId exists in any state, so branch on the retained job's state.
   */
  private async recoverStuckProcessing(): Promise<{
    requeued: number;
    failedStuck: number;
  }> {
    const stuck = await this.videoRepository.findBy({
      processing_status: VideoProcessingStatus.PROCESSING,
      updated_at: LessThan(
        this.ago(this.upload.processingStuckAfterMinutes * 60 * 1000),
      ),
    });

    let requeued = 0;
    let failedStuck = 0;
    await this.forEachIsolated(stuck, async (video) => {
      const job = await this.queue.getJob(video.id);
      const state = job ? await job.getState() : undefined;

      if (state === 'failed') {
        // The final `failed` event did not persist: settle it as a transient failure.
        const { affected } = await this.videoRepository.update(
          { id: video.id, processing_status: VideoProcessingStatus.PROCESSING },
          {
            processing_status: VideoProcessingStatus.FAILED,
            processing_error: VIDEO_PROCESSING_ERRORS.PROCESSING_FAILED,
          },
        );
        failedStuck += affected ?? 0;
      } else if (!job || state === 'completed' || state === 'unknown') {
        await job?.remove();
        await this.videoProcessingProducer.enqueueProcessVideo(video.id);
        requeued++;
      }
      // active / waiting / delayed / prioritized: the job is still on its way.
    });
    return { requeued, failedStuck };
  }

  /** Step 3: `failed` rows whose original is still stored (a best-effort delete failed). */
  private async deleteLeftoverOriginals(): Promise<number> {
    const failed = await this.videoRepository.find({
      select: { id: true },
      where: { processing_status: VideoProcessingStatus.FAILED },
    });

    let deleted = 0;
    await this.forEachIsolated(failed, async ({ id }) => {
      const key = originalObjectKey(id);
      const size = await this.storageService.headObject(
        this.storage.buckets.videos,
        key,
      );
      if (size !== null) {
        await this.storageService.deleteObject(
          this.storage.buckets.videos,
          key,
        );
        deleted++;
      }
    });
    return deleted;
  }

  /** The MinIO stale-upload backstop may already have dropped the multipart (TD-11). */
  private async abortIgnoringMissing(
    videoId: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(
        this.storage.buckets.videos,
        originalObjectKey(videoId),
        uploadId,
      );
    } catch (error) {
      if (!(error instanceof NoSuchUpload)) {
        throw error;
      }
    }
  }

  /**
   * Scheduled job: one bad row is logged and skipped so it never blocks the rest of the
   * sweep; the next run retries it.
   */
  private async forEachIsolated<T extends Pick<Video, 'id'>>(
    videos: T[],
    work: (video: T) => Promise<void>,
  ): Promise<void> {
    for (const video of videos) {
      try {
        await work(video);
      } catch (error) {
        this.logger.error(
          `Failed to reconcile video ${video.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  private ago(ms: number): Date {
    return new Date(Date.now() - ms);
  }
}
