import { NoSuchUpload } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import storageConfig from '../../config/storage.config';
import uploadConfig from '../../config/upload.config';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import { VideoProcessingProducer } from '../../queue/video-processing.producer';
import { StorageService } from '../../storage/storage.service';
import {
  Video,
  VideoProcessingStatus,
} from '../../videos/entities/video.entity';
import { UploadReconcilerService } from './upload-reconciler.service';

type Row = Pick<Video, 'id' | 'upload_id'>;

describe('UploadReconcilerService', () => {
  let service: UploadReconcilerService;
  const rows: Record<VideoProcessingStatus, Row[]> = {
    [VideoProcessingStatus.UPLOADING]: [],
    [VideoProcessingStatus.PROCESSING]: [],
    [VideoProcessingStatus.READY]: [],
    [VideoProcessingStatus.FAILED]: [],
  };
  const videoRepository = {
    findBy: jest.fn(),
    find: jest.fn(),
    update: jest.fn(),
  };
  const queue = { getJob: jest.fn() };
  const producer = { enqueueProcessVideo: jest.fn() };
  const storageService = {
    abortMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    for (const status of Object.values(VideoProcessingStatus)) {
      rows[status] = [];
    }
    videoRepository.findBy.mockImplementation(
      ({ processing_status }: { processing_status: VideoProcessingStatus }) =>
        Promise.resolve(rows[processing_status]),
    );
    videoRepository.find.mockImplementation(
      ({ where }: { where: { processing_status: VideoProcessingStatus } }) =>
        Promise.resolve(rows[where.processing_status]),
    );
    videoRepository.update.mockResolvedValue({ affected: 1 });
    storageService.headObject.mockResolvedValue(null);

    const module = await Test.createTestingModule({
      providers: [
        UploadReconcilerService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
        { provide: VideoProcessingProducer, useValue: producer },
        { provide: StorageService, useValue: storageService },
        {
          provide: storageConfig.KEY,
          useValue: { buckets: { videos: 'videos', thumbnails: 'thumbnails' } },
        },
        {
          provide: uploadConfig.KEY,
          useValue: { abandonAfterHours: 24, processingStuckAfterMinutes: 60 },
        },
      ],
    }).compile();
    service = module.get(UploadReconcilerService);
  });

  function jobIn(state: string) {
    return { getState: jest.fn().mockResolvedValue(state), remove: jest.fn() };
  }

  describe('stuck processing videos', () => {
    beforeEach(() => {
      rows[VideoProcessingStatus.PROCESSING] = [{ id: 'v1', upload_id: null }];
    });

    it('should re-enqueue process-video when the job is absent', async () => {
      queue.getJob.mockResolvedValue(undefined);

      const summary = await service.run();

      expect(producer.enqueueProcessVideo).toHaveBeenCalledWith('v1');
      expect(summary.requeued).toBe(1);
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should remove a completed job before re-enqueuing, since add() ignores a retained jobId', async () => {
      const job = jobIn('completed');
      queue.getJob.mockResolvedValue(job);

      await service.run();

      expect(job.remove).toHaveBeenCalled();
      expect(producer.enqueueProcessVideo).toHaveBeenCalledWith('v1');
      expect(job.remove.mock.invocationCallOrder[0]).toBeLessThan(
        producer.enqueueProcessVideo.mock.invocationCallOrder[0],
      );
    });

    it('should mark the video PROCESSING_FAILED, conditionally, when the job failed', async () => {
      const job = jobIn('failed');
      queue.getJob.mockResolvedValue(job);

      const summary = await service.run();

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'v1', processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          processing_error: 'PROCESSING_FAILED',
        },
      );
      expect(summary.failedStuck).toBe(1);
      expect(job.remove).not.toHaveBeenCalled();
      expect(producer.enqueueProcessVideo).not.toHaveBeenCalled();
    });

    it.each(['active', 'waiting', 'delayed', 'prioritized'])(
      'should leave the video and its job untouched when the job is %s',
      async (state) => {
        const job = jobIn(state);
        queue.getJob.mockResolvedValue(job);

        await service.run();

        expect(job.remove).not.toHaveBeenCalled();
        expect(producer.enqueueProcessVideo).not.toHaveBeenCalled();
        expect(videoRepository.update).not.toHaveBeenCalled();
      },
    );
  });

  describe('abandoned uploads', () => {
    it('should still fail the video when the multipart is already gone', async () => {
      rows[VideoProcessingStatus.UPLOADING] = [{ id: 'v1', upload_id: 'up-1' }];
      storageService.abortMultipartUpload.mockRejectedValue(
        new NoSuchUpload({ message: 'gone', $metadata: {} }),
      );

      const summary = await service.run();

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'v1', processing_status: VideoProcessingStatus.UPLOADING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          processing_error: 'UPLOAD_ABANDONED',
          upload_id: null,
        },
      );
      expect(summary.abandonedUploads).toBe(1);
    });

    it('should skip a row whose abort fails for another reason and keep sweeping', async () => {
      rows[VideoProcessingStatus.UPLOADING] = [
        { id: 'v1', upload_id: 'up-1' },
        { id: 'v2', upload_id: 'up-2' },
      ];
      storageService.abortMultipartUpload
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockResolvedValueOnce(undefined);

      const summary = await service.run();

      expect(videoRepository.update).toHaveBeenCalledTimes(1);
      expect(videoRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'v2' }),
        expect.anything(),
      );
      expect(summary.abandonedUploads).toBe(1);
    });
  });
});
