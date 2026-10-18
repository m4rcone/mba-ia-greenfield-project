import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { StorageService } from '../storage/storage.service';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import {
  InvalidPartNumberException,
  UnsupportedVideoFormatException,
  UploadIncompleteException,
  UploadNotInProgressException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { VideosService } from './videos.service';

const MIB = 1024 * 1024;
const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const UPLOAD_ID = 'upload-1';

function uniqueViolation(column: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: `Key (${column})=(x) already exists.`,
    }),
  );
}

function uploadingVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: 'video-1',
    public_id: 'aB3dE5gH7jK',
    channel_id: CHANNEL_ID,
    processing_status: VideoProcessingStatus.UPLOADING,
    processing_error: null,
    size_bytes: 3 * MIB,
    upload_id: UPLOAD_ID,
    part_size: MIB,
    part_count: 3,
    ...overrides,
  });
}

function storedParts(...partNumbers: number[]) {
  return partNumbers.map((partNumber) => ({
    partNumber,
    etag: `"etag-${partNumber}"`,
    size: MIB,
  }));
}

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn((data: Partial<Video>) => Object.assign(new Video(), data)),
    insert: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    listParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
    getPublicObjectUrl: jest.fn(),
    presignGet: jest.fn(),
  };
  const producer = { enqueueProcessVideo: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    videoRepository.create.mockImplementation((data: Partial<Video>) =>
      Object.assign(new Video(), data),
    );
    channelsService.findByUserId.mockResolvedValue({ id: CHANNEL_ID });
    storageService.createMultipartUpload.mockResolvedValue(UPLOAD_ID);
    storageService.abortMultipartUpload.mockResolvedValue(undefined);
    videoRepository.update.mockResolvedValue({ affected: 1 });

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: VideoProcessingProducer, useValue: producer },
        {
          provide: uploadConfig.KEY,
          useValue: { maxSizeBytes: 10737418240, partSizeBytes: 16 * MIB },
        },
        {
          provide: storageConfig.KEY,
          useValue: {
            buckets: { videos: 'videos', thumbnails: 'thumbnails' },
            presignedGetTtlSeconds: 14400,
          },
        },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    const input = {
      fileName: 'My Holiday.mp4',
      contentType: 'video/mp4',
      fileSize: 10737418240,
    };

    it.each([
      ['clip.avi', 'video/x-msvideo'],
      ['clip.mov', 'video/mp4'],
    ])(
      'should reject %s declared as %s with UNSUPPORTED_VIDEO_FORMAT before touching storage',
      async (fileName, contentType) => {
        await expect(
          service.initiateUpload(USER_ID, { ...input, fileName, contentType }),
        ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);
        expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
      },
    );

    it('should persist a draft with the configured part size for a 10 GiB file', async () => {
      const video = await service.initiateUpload(USER_ID, input);

      expect(videoRepository.insert).toHaveBeenCalledTimes(1);
      expect(video).toMatchObject({
        channel_id: CHANNEL_ID,
        title: 'My Holiday',
        original_filename: 'My Holiday.mp4',
        upload_id: UPLOAD_ID,
        part_size: 16 * MIB,
        part_count: 640,
      });
      expect(video.public_id).toMatch(/^[0-9A-Za-z]{11}$/);
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        'videos',
        `videos/${video.id}/original`,
        'video/mp4',
      );
    });

    it('should grow the part size so the upload never exceeds 10 000 parts, rounded to a MiB', async () => {
      // ceil(200 GiB / 10 000) ≈ 20.48 MiB → 21 MiB
      const fileSize = 200 * 1024 * MIB;

      const video = await service.initiateUpload(USER_ID, {
        ...input,
        fileSize,
      });

      expect(video.part_size).toBe(21 * MIB);
      expect(video.part_count).toBe(Math.ceil(fileSize / (21 * MIB)));
      expect(video.part_count).toBeLessThanOrEqual(10_000);
    });

    it('should retry the insert with a new public_id on a public_id unique violation', async () => {
      const publicIds: string[] = [];
      videoRepository.insert.mockImplementation((video: Video) => {
        publicIds.push(video.public_id);
        return publicIds.length === 1
          ? Promise.reject(uniqueViolation('public_id'))
          : Promise.resolve({});
      });

      await service.initiateUpload(USER_ID, input);

      expect(videoRepository.insert).toHaveBeenCalledTimes(2);
      expect(publicIds[0]).not.toBe(publicIds[1]);
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should abort the multipart upload and propagate when the insert fails definitively', async () => {
      const failure = new Error('connection lost');
      videoRepository.insert.mockRejectedValue(failure);

      await expect(service.initiateUpload(USER_ID, input)).rejects.toBe(
        failure,
      );
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos',
        expect.stringMatching(/^videos\/.+\/original$/),
        UPLOAD_ID,
      );
    });

    it('should abort the multipart upload after exhausting public_id retries', async () => {
      videoRepository.insert.mockRejectedValue(uniqueViolation('public_id'));

      await expect(
        service.initiateUpload(USER_ID, input),
      ).rejects.toBeInstanceOf(QueryFailedError);
      expect(videoRepository.insert).toHaveBeenCalledTimes(5);
      expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('should not insert anything when CreateMultipartUpload fails', async () => {
      storageService.createMultipartUpload.mockRejectedValue(
        new Error('storage down'),
      );

      await expect(service.initiateUpload(USER_ID, input)).rejects.toThrow(
        'storage down',
      );
      expect(videoRepository.insert).not.toHaveBeenCalled();
    });
  });

  describe('owner-only access', () => {
    it('should throw VIDEO_NOT_FOUND when the video is not owned by the user', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.cancelUpload('video-1', 'intruder'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'video-1', channel: { user_id: 'intruder' } },
      });
    });
  });

  describe('upload state guard', () => {
    it.each([
      [
        'presignParts',
        (s: VideosService) => s.presignParts('video-1', USER_ID, [1]),
      ],
      [
        'listUploadedParts',
        (s: VideosService) => s.listUploadedParts('video-1', USER_ID),
      ],
      [
        'completeUpload',
        (s: VideosService) => s.completeUpload('video-1', USER_ID),
      ],
      [
        'cancelUpload',
        (s: VideosService) => s.cancelUpload('video-1', USER_ID),
      ],
    ])(
      '%s should throw UPLOAD_NOT_IN_PROGRESS when the video is past uploading',
      async (_name, call) => {
        videoRepository.findOne.mockResolvedValue(
          uploadingVideo({
            processing_status: VideoProcessingStatus.PROCESSING,
            upload_id: null,
          }),
        );

        await expect(call(service)).rejects.toBeInstanceOf(
          UploadNotInProgressException,
        );
      },
    );
  });

  describe('presignParts', () => {
    it('should throw INVALID_PART_NUMBER when a part number exceeds part_count', async () => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());

      await expect(
        service.presignParts('video-1', USER_ID, [1, 4]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should return one URL per part with the 900 s TTL', async () => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());
      storageService.presignUploadPart.mockImplementation(
        (_b: string, _k: string, _u: string, n: number) =>
          Promise.resolve(`https://signed/${n}`),
      );

      const result = await service.presignParts('video-1', USER_ID, [2, 3]);

      expect(result).toEqual({
        parts: [
          { partNumber: 2, url: 'https://signed/2' },
          { partNumber: 3, url: 'https://signed/3' },
        ],
        expiresIn: 900,
      });
    });
  });

  describe('completeUpload', () => {
    it('should throw UPLOAD_INCOMPLETE and leave the video untouched when a part is missing', async () => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());
      storageService.listParts.mockResolvedValue(storedParts(1, 3));

      await expect(
        service.completeUpload('video-1', USER_ID),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should complete with the server-side part list, move to processing and enqueue', async () => {
      const video = uploadingVideo();
      videoRepository.findOne.mockResolvedValue(video);
      const parts = storedParts(1, 2, 3);
      storageService.listParts.mockResolvedValue(parts);
      storageService.headObject.mockResolvedValue(3 * MIB);

      const result = await service.completeUpload('video-1', USER_ID);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos',
        'videos/video-1/original',
        UPLOAD_ID,
        parts,
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1', processing_status: VideoProcessingStatus.UPLOADING },
        {
          processing_status: VideoProcessingStatus.PROCESSING,
          upload_id: null,
        },
      );
      expect(producer.enqueueProcessVideo).toHaveBeenCalledWith('video-1');
      expect(result).toMatchObject({
        processing_status: VideoProcessingStatus.PROCESSING,
        upload_id: null,
      });
    });

    it('should delete the object, mark failed and throw UPLOAD_SIZE_MISMATCH on a size mismatch', async () => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());
      storageService.listParts.mockResolvedValue(storedParts(1, 2, 3));
      storageService.headObject.mockResolvedValue(3 * MIB - 1);

      await expect(
        service.completeUpload('video-1', USER_ID),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storageService.deleteObject).toHaveBeenCalledWith(
        'videos',
        'videos/video-1/original',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1', processing_status: VideoProcessingStatus.UPLOADING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          processing_error: 'UPLOAD_SIZE_MISMATCH',
          upload_id: null,
        },
      );
      expect(producer.enqueueProcessVideo).not.toHaveBeenCalled();
    });

    it('should not enqueue when a concurrent request already left uploading', async () => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());
      storageService.listParts.mockResolvedValue(storedParts(1, 2, 3));
      storageService.headObject.mockResolvedValue(3 * MIB);
      videoRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.completeUpload('video-1', USER_ID),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);
      expect(producer.enqueueProcessVideo).not.toHaveBeenCalled();
    });
  });

  describe('cancelUpload', () => {
    it('should abort the multipart upload and mark the video failed with UPLOAD_CANCELLED', async () => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());

      await service.cancelUpload('video-1', USER_ID);

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos',
        'videos/video-1/original',
        UPLOAD_ID,
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1', processing_status: VideoProcessingStatus.UPLOADING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          processing_error: 'UPLOAD_CANCELLED',
          upload_id: null,
        },
      );
    });
  });

  describe('getOwnedVideo', () => {
    it('should return a null thumbnail_url while the video is not ready', async () => {
      videoRepository.findOne.mockResolvedValue(
        uploadingVideo({
          processing_status: VideoProcessingStatus.PROCESSING,
          thumbnail_key: 'thumbnails/video-1/default.jpg',
        }),
      );

      const result = await service.getOwnedVideo('video-1', USER_ID);

      expect(result.thumbnail_url).toBeNull();
      expect(storageService.getPublicObjectUrl).not.toHaveBeenCalled();
    });

    it('should expose metadata and the public thumbnail URL once ready', async () => {
      videoRepository.findOne.mockResolvedValue(
        uploadingVideo({
          processing_status: VideoProcessingStatus.READY,
          upload_id: null,
          duration_seconds: 12.5,
          width: 1280,
          height: 720,
          video_codec: 'h264',
          audio_codec: null,
          thumbnail_key: 'thumbnails/video-1/default.jpg',
        }),
      );
      storageService.getPublicObjectUrl.mockReturnValue(
        'http://localhost:9000/thumbnails/thumbnails/video-1/default.jpg',
      );

      const result = await service.getOwnedVideo('video-1', USER_ID);

      expect(storageService.getPublicObjectUrl).toHaveBeenCalledWith(
        'thumbnails',
        'thumbnails/video-1/default.jpg',
      );
      expect(result).toMatchObject({
        processing_status: VideoProcessingStatus.READY,
        duration_seconds: 12.5,
        width: 1280,
        height: 720,
        video_codec: 'h264',
        audio_codec: null,
        thumbnail_url:
          'http://localhost:9000/thumbnails/thumbnails/video-1/default.jpg',
      });
    });
  });

  describe('getPlaybackUrl', () => {
    const readyVideo = () =>
      uploadingVideo({
        processing_status: VideoProcessingStatus.READY,
        upload_id: null,
        content_type: 'video/mp4',
        original_filename: "vídeo de férias (1)'s.mp4",
      });

    it.each(['abc!', 'short', 'aB3dE5gH7jK0', ''])(
      'should throw VIDEO_NOT_FOUND for the malformed publicId %p without querying',
      async (publicId) => {
        await expect(
          service.getPlaybackUrl(publicId, USER_ID, 'stream'),
        ).rejects.toBeInstanceOf(VideoNotFoundException);
        expect(videoRepository.findOne).not.toHaveBeenCalled();
      },
    );

    it('should throw VIDEO_NOT_FOUND when the video belongs to another user', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getPlaybackUrl('aB3dE5gH7jK', 'intruder', 'stream'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { public_id: 'aB3dE5gH7jK', channel: { user_id: 'intruder' } },
      });
    });

    it('should throw VIDEO_NOT_READY while the video is processing', async () => {
      videoRepository.findOne.mockResolvedValue(
        uploadingVideo({ processing_status: VideoProcessingStatus.PROCESSING }),
      );

      await expect(
        service.getPlaybackUrl('aB3dE5gH7jK', USER_ID, 'download'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
      expect(storageService.presignGet).not.toHaveBeenCalled();
    });

    it('should presign the original with the stored content type and no disposition for stream', async () => {
      videoRepository.findOne.mockResolvedValue(readyVideo());
      storageService.presignGet.mockResolvedValue('https://signed/stream');

      const url = await service.getPlaybackUrl(
        'aB3dE5gH7jK',
        USER_ID,
        'stream',
      );

      expect(url).toBe('https://signed/stream');
      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos',
        'videos/video-1/original',
        {
          expiresIn: 14400,
          responseContentType: 'video/mp4',
          responseContentDisposition: undefined,
        },
      );
    });

    it('should bake an RFC 5987 attachment disposition with the UTF-8 original name for download', async () => {
      videoRepository.findOne.mockResolvedValue(readyVideo());
      storageService.presignGet.mockResolvedValue('https://signed/download');

      await service.getPlaybackUrl('aB3dE5gH7jK', USER_ID, 'download');

      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos',
        'videos/video-1/original',
        expect.objectContaining({
          responseContentDisposition:
            "attachment; filename*=UTF-8''v%C3%ADdeo%20de%20f%C3%A9rias%20%281%29%27s.mp4",
        }),
      );
    });
  });
});
