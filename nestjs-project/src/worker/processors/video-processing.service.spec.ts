import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import storageConfig from '../../config/storage.config';
import { StorageService } from '../../storage/storage.service';
import {
  Video,
  VideoProcessingStatus,
} from '../../videos/entities/video.entity';
import { MediaProbeService } from '../media/media-probe.service';
import { MediaValidationError } from '../media/media-validation.error';
import { ThumbnailService } from '../media/thumbnail.service';
import { MediaUnrecoverableError } from './media-unrecoverable.error';
import { VideoProcessingService } from './video-processing.service';

const VIDEO_ID = 'video-1';
const METADATA = {
  durationSeconds: 2,
  width: 320,
  height: 240,
  videoCodec: 'h264',
  audioCodec: 'aac',
};

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  const videoRepository = { findOneBy: jest.fn(), update: jest.fn() };
  const storageService = {
    presignInternalGet: jest.fn(),
    putObject: jest.fn(),
    deleteObject: jest.fn(),
    deletePrefix: jest.fn(),
  };
  const mediaProbeService = { probeAndValidate: jest.fn() };
  const thumbnailService = { extractFrame: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    storageService.presignInternalGet.mockResolvedValue('http://minio/signed');
    mediaProbeService.probeAndValidate.mockResolvedValue(METADATA);
    thumbnailService.extractFrame.mockResolvedValue(Buffer.from([0xff, 0xd8]));
    videoRepository.update.mockResolvedValue({ affected: 1 });

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: MediaProbeService, useValue: mediaProbeService },
        { provide: ThumbnailService, useValue: thumbnailService },
        {
          provide: storageConfig.KEY,
          useValue: { buckets: { videos: 'videos', thumbnails: 'thumbnails' } },
        },
      ],
    }).compile();
    service = module.get(VideoProcessingService);
  });

  function withStatus(processing_status: VideoProcessingStatus) {
    videoRepository.findOneBy.mockResolvedValue(
      Object.assign(new Video(), { id: VIDEO_ID, processing_status }),
    );
  }

  describe('process', () => {
    it.each([
      VideoProcessingStatus.READY,
      VideoProcessingStatus.FAILED,
      VideoProcessingStatus.UPLOADING,
    ])('should be a no-op for a video that is %s', async (status) => {
      withStatus(status);

      await service.process(VIDEO_ID);

      expect(storageService.presignInternalGet).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should be a no-op when the video no longer exists', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await service.process(VIDEO_ID);

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should write the deterministic thumbnail and move processing → ready with the metadata', async () => {
      withStatus(VideoProcessingStatus.PROCESSING);

      await service.process(VIDEO_ID);

      expect(storageService.presignInternalGet).toHaveBeenCalledWith(
        'videos',
        'videos/video-1/original',
      );
      expect(thumbnailService.extractFrame).toHaveBeenCalledWith(
        'http://minio/signed',
        2,
      );
      expect(storageService.putObject).toHaveBeenCalledWith(
        'thumbnails',
        'thumbnails/video-1/default.jpg',
        Buffer.from([0xff, 0xd8]),
        'image/jpeg',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.READY,
          duration_seconds: 2,
          width: 320,
          height: 240,
          video_codec: 'h264',
          audio_codec: 'aac',
          thumbnail_key: 'thumbnails/video-1/default.jpg',
        },
      );
    });

    it('should turn invalid media into an UnrecoverableError carrying the typed code', async () => {
      withStatus(VideoProcessingStatus.PROCESSING);
      mediaProbeService.probeAndValidate.mockRejectedValue(
        new MediaValidationError('NOT_A_VIDEO'),
      );

      const err = await service.process(VIDEO_ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(UnrecoverableError);
      expect((err as MediaUnrecoverableError).code).toBe('NOT_A_VIDEO');
      expect(thumbnailService.extractFrame).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should propagate I/O errors unchanged so BullMQ retries them', async () => {
      withStatus(VideoProcessingStatus.PROCESSING);
      const ioError = new Error('ffprobe failed: Server returned 503');
      mediaProbeService.probeAndValidate.mockRejectedValue(ioError);

      await expect(service.process(VIDEO_ID)).rejects.toBe(ioError);
    });
  });

  describe('markFailed', () => {
    it('should persist the media code conditionally and remove the original and thumbnails', async () => {
      await service.markFailed(
        VIDEO_ID,
        new MediaUnrecoverableError('CORRUPT_MEDIA'),
      );

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          processing_error: 'CORRUPT_MEDIA',
        },
      );
      expect(storageService.deleteObject).toHaveBeenCalledWith(
        'videos',
        'videos/video-1/original',
      );
      expect(storageService.deletePrefix).toHaveBeenCalledWith(
        'thumbnails',
        'thumbnails/video-1/',
      );
    });

    it('should persist PROCESSING_FAILED and keep the objects for a transient failure', async () => {
      await service.markFailed(VIDEO_ID, new Error('timeout'));

      expect(videoRepository.update).toHaveBeenCalledWith(expect.anything(), {
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: 'PROCESSING_FAILED',
      });
      expect(storageService.deleteObject).not.toHaveBeenCalled();
    });

    it('should not throw when removing the media objects fails', async () => {
      storageService.deleteObject.mockRejectedValue(new Error('storage down'));

      await expect(
        service.markFailed(
          VIDEO_ID,
          new MediaUnrecoverableError('NOT_A_VIDEO'),
        ),
      ).resolves.toBeUndefined();
    });
  });
});
