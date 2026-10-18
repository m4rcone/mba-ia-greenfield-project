import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOnColumn } from '../common/database/pg-errors';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { PRESIGNED_PART_URL_TTL_SECONDS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import {
  Video,
  VideoProcessingStatus,
  VideoStatus,
} from './entities/video.entity';
import { VideoResponseDto } from './dto/video-response.dto';
import {
  InvalidPartNumberException,
  UnsupportedVideoFormatException,
  UploadIncompleteException,
  UploadNotInProgressException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { PUBLIC_ID_PATTERN, generatePublicId } from './public-id.util';
import { isDeclaredFormatAllowed } from './video-formats';
import {
  MIB,
  PART_COUNT_LIMIT,
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_PROCESSING_ERRORS,
  originalObjectKey,
} from './videos.constants';

export interface InitiateUploadInput {
  fileName: string;
  contentType: string;
  fileSize: number;
}

export interface PresignedParts {
  parts: { partNumber: number; url: string }[];
  expiresIn: number;
}

export interface UploadProgress {
  partSize: number;
  partCount: number;
  uploadedParts: { partNumber: number; size: number }[];
}

export type PlaybackMode = 'stream' | 'download';

/** An owned video whose multipart upload is open (`processing_status=uploading`). */
type UploadingVideo = Video & { upload_id: string };

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoProcessingProducer: VideoProcessingProducer,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    input: InitiateUploadInput,
  ): Promise<Video> {
    if (!isDeclaredFormatAllowed(input.fileName, input.contentType)) {
      throw new UnsupportedVideoFormatException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const partSize = this.computePartSize(input.fileSize);
    const id = randomUUID();
    const key = originalObjectKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      this.storage.buckets.videos,
      key,
      input.contentType,
    );

    const video = this.videoRepository.create({
      id,
      channel_id: channel.id,
      title: parse(input.fileName).name,
      status: VideoStatus.DRAFT,
      processing_status: VideoProcessingStatus.UPLOADING,
      original_filename: input.fileName,
      content_type: input.contentType,
      size_bytes: input.fileSize,
      upload_id: uploadId,
      part_size: partSize,
      part_count: Math.ceil(input.fileSize / partSize),
    });

    try {
      await this.insertWithUniquePublicId(video);
    } catch (err) {
      // Nothing references the multipart upload yet; abort it so no orphan parts remain.
      await this.storageService
        .abortMultipartUpload(this.storage.buckets.videos, key, uploadId)
        .catch((abortErr: unknown) =>
          this.logger.error(
            `Failed to abort multipart upload ${uploadId} after insert failure`,
            abortErr instanceof Error ? abortErr.stack : String(abortErr),
          ),
        );
      throw err;
    }
    return video;
  }

  async presignParts(
    videoId: string,
    userId: string,
    partNumbers: number[],
  ): Promise<PresignedParts> {
    const video = await this.findUploadingOrFail(videoId, userId);
    if (partNumbers.some((n) => n > video.part_count)) {
      throw new InvalidPartNumberException();
    }

    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          this.storage.buckets.videos,
          originalObjectKey(video.id),
          video.upload_id,
          partNumber,
          PRESIGNED_PART_URL_TTL_SECONDS,
        ),
      })),
    );
    return { parts, expiresIn: PRESIGNED_PART_URL_TTL_SECONDS };
  }

  async listUploadedParts(
    videoId: string,
    userId: string,
  ): Promise<UploadProgress> {
    const video = await this.findUploadingOrFail(videoId, userId);
    const parts = await this.storageService.listParts(
      this.storage.buckets.videos,
      originalObjectKey(video.id),
      video.upload_id,
    );
    return {
      partSize: video.part_size,
      partCount: video.part_count,
      uploadedParts: parts.map(({ partNumber, size }) => ({
        partNumber,
        size,
      })),
    };
  }

  async completeUpload(videoId: string, userId: string): Promise<Video> {
    const video = await this.findUploadingOrFail(videoId, userId);
    const bucket = this.storage.buckets.videos;
    const key = originalObjectKey(video.id);

    // The part list is built from storage, never from client input (TD-02).
    const parts = await this.storageService.listParts(
      bucket,
      key,
      video.upload_id,
    );
    const stored = new Set(parts.map((p) => p.partNumber));
    const coversAllParts =
      stored.size === video.part_count &&
      parts.every((p) => p.partNumber >= 1 && p.partNumber <= video.part_count);
    if (!coversAllParts) {
      throw new UploadIncompleteException();
    }

    await this.storageService.completeMultipartUpload(
      bucket,
      key,
      video.upload_id,
      parts,
    );

    const storedSize = await this.storageService.headObject(bucket, key);
    if (storedSize !== video.size_bytes) {
      await this.storageService.deleteObject(bucket, key);
      await this.transitionFromUploading(video, {
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: VIDEO_PROCESSING_ERRORS.UPLOAD_SIZE_MISMATCH,
      });
      throw new UploadSizeMismatchException();
    }

    await this.transitionFromUploading(video, {
      processing_status: VideoProcessingStatus.PROCESSING,
    });
    // A crash before this enqueue is recovered by the reconciler (TD-11).
    await this.videoProcessingProducer.enqueueProcessVideo(video.id);
    return video;
  }

  async cancelUpload(videoId: string, userId: string): Promise<void> {
    const video = await this.findUploadingOrFail(videoId, userId);
    await this.storageService.abortMultipartUpload(
      this.storage.buckets.videos,
      originalObjectKey(video.id),
      video.upload_id,
    );
    await this.transitionFromUploading(video, {
      processing_status: VideoProcessingStatus.FAILED,
      processing_error: VIDEO_PROCESSING_ERRORS.UPLOAD_CANCELLED,
    });
  }

  async getOwnedVideo(
    videoId: string,
    userId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedOrFail(videoId, userId);
    const thumbnailUrl =
      video.processing_status === VideoProcessingStatus.READY &&
      video.thumbnail_key !== null
        ? this.storageService.getPublicObjectUrl(
            this.storage.buckets.thumbnails,
            video.thumbnail_key,
          )
        : null;
    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      processing_status: video.processing_status,
      processing_error: video.processing_error,
      duration_seconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      video_codec: video.video_codec,
      audio_codec: video.audio_codec,
      thumbnail_url: thumbnailUrl,
    };
  }

  /** Presigned GET for the original; storage serves Range/206 directly (TD-08). */
  async getPlaybackUrl(
    publicId: string,
    userId: string,
    mode: PlaybackMode,
  ): Promise<string> {
    if (!PUBLIC_ID_PATTERN.test(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.processing_status !== VideoProcessingStatus.READY) {
      throw new VideoNotReadyException();
    }
    return this.storageService.presignGet(
      this.storage.buckets.videos,
      originalObjectKey(video.id),
      {
        expiresIn: this.storage.presignedGetTtlSeconds,
        responseContentType: video.content_type,
        responseContentDisposition:
          mode === 'download'
            ? attachmentDisposition(video.original_filename)
            : undefined,
      },
    );
  }

  /** Non-owners get the same error as a missing video, so existence never leaks (TD-08). */
  async findOwnedOrFail(videoId: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async findUploadingOrFail(
    videoId: string,
    userId: string,
  ): Promise<UploadingVideo> {
    const video = await this.findOwnedOrFail(videoId, userId);
    if (
      video.processing_status !== VideoProcessingStatus.UPLOADING ||
      video.upload_id === null
    ) {
      throw new UploadNotInProgressException();
    }
    return video as UploadingVideo;
  }

  /**
   * Conditional `uploading → *` transition that also clears `upload_id`; a concurrent
   * request that already moved the row out of `uploading` makes it a no-op.
   */
  private async transitionFromUploading(
    video: Video,
    changes: Pick<Video, 'processing_status'> &
      Partial<Pick<Video, 'processing_error'>>,
  ): Promise<void> {
    const { affected } = await this.videoRepository.update(
      { id: video.id, processing_status: VideoProcessingStatus.UPLOADING },
      { ...changes, upload_id: null },
    );
    if (!affected) {
      throw new UploadNotInProgressException();
    }
    Object.assign(video, changes, { upload_id: null });
  }

  /** `max(configured, ceil(size / 10 000))` rounded up to a whole MiB (TD-02). */
  private computePartSize(fileSize: number): number {
    const minimum = Math.max(
      this.upload.partSizeBytes,
      Math.ceil(fileSize / PART_COUNT_LIMIT),
    );
    return Math.ceil(minimum / MIB) * MIB;
  }

  private async insertWithUniquePublicId(video: Video): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      video.public_id = generatePublicId();
      try {
        await this.videoRepository.insert(video);
        return;
      } catch (err) {
        if (
          !isUniqueViolationOnColumn(err, 'public_id') ||
          attempt >= PUBLIC_ID_MAX_ATTEMPTS
        ) {
          throw err;
        }
      }
    }
  }
}

/** RFC 6266 / RFC 5987 `filename*` so UTF-8 names survive the download. */
function attachmentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}
