import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import storageConfig from '../../config/storage.config';
import { StorageService } from '../../storage/storage.service';
import {
  Video,
  VideoProcessingStatus,
} from '../../videos/entities/video.entity';
import {
  VIDEO_PROCESSING_ERRORS,
  originalObjectKey,
  thumbnailObjectKey,
  thumbnailPrefix,
} from '../../videos/videos.constants';
import { MediaProbeService } from '../media/media-probe.service';
import { MediaValidationError } from '../media/media-validation.error';
import { ThumbnailService } from '../media/thumbnail.service';
import { MediaUnrecoverableError } from './media-unrecoverable.error';

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaProbeService: MediaProbeService,
    private readonly thumbnailService: ThumbnailService,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Idempotent (at-least-once delivery, TD-10): only a `processing` row is worked on,
   * outputs are deterministic and the final update is conditional.
   */
  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (video?.processing_status !== VideoProcessingStatus.PROCESSING) {
      this.logger.log(
        `Skipping video ${videoId}: ${video ? video.processing_status : 'not found'}`,
      );
      return;
    }

    const url = await this.storageService.presignInternalGet(
      this.storage.buckets.videos,
      originalObjectKey(videoId),
    );
    const metadata = await this.probeOrFailPermanently(url);
    const frame = await this.thumbnailService.extractFrame(
      url,
      metadata.durationSeconds,
    );
    const thumbnailKey = thumbnailObjectKey(videoId);
    await this.storageService.putObject(
      this.storage.buckets.thumbnails,
      thumbnailKey,
      frame,
      'image/jpeg',
    );

    await this.videoRepository.update(
      { id: videoId, processing_status: VideoProcessingStatus.PROCESSING },
      {
        processing_status: VideoProcessingStatus.READY,
        duration_seconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
        video_codec: metadata.videoCodec,
        audio_codec: metadata.audioCodec,
        thumbnail_key: thumbnailKey,
      },
    );
  }

  /**
   * Final failure of a `process-video` job. Runs from a worker event, so errors are
   * logged rather than thrown (nothing upstream could handle them).
   */
  async markFailed(videoId: string, err: Error): Promise<void> {
    const isMediaFailure = err instanceof MediaUnrecoverableError;
    const processingError = isMediaFailure
      ? err.code
      : VIDEO_PROCESSING_ERRORS.PROCESSING_FAILED;
    try {
      await this.videoRepository.update(
        { id: videoId, processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          processing_error: processingError,
        },
      );
    } catch (updateErr) {
      this.logger.error(
        `Failed to mark video ${videoId} as failed (${processingError})`,
        updateErr instanceof Error ? updateErr.stack : String(updateErr),
      );
      return;
    }

    if (isMediaFailure) {
      await this.removeMediaObjects(videoId);
    }
  }

  private async probeOrFailPermanently(url: string) {
    try {
      return await this.mediaProbeService.probeAndValidate(url);
    } catch (err) {
      if (err instanceof MediaValidationError) {
        throw new MediaUnrecoverableError(err.code);
      }
      throw err; // transient: BullMQ retries with exponential backoff
    }
  }

  /** Best effort: a leftover object is swept later by the reconciler (TD-14). */
  private async removeMediaObjects(videoId: string): Promise<void> {
    try {
      await this.storageService.deleteObject(
        this.storage.buckets.videos,
        originalObjectKey(videoId),
      );
      await this.storageService.deletePrefix(
        this.storage.buckets.thumbnails,
        thumbnailPrefix(videoId),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to remove media objects of video ${videoId}: ${String(err)}`,
      );
    }
  }
}
