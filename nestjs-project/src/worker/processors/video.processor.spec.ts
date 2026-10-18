import { Test } from '@nestjs/testing';
import { type Job, UnrecoverableError } from 'bullmq';
import { UploadReconcilerService } from '../reconciler/upload-reconciler.service';
import { MediaUnrecoverableError } from './media-unrecoverable.error';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'video-1',
    name: 'process-video',
    data: { videoId: 'video-1' },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...overrides,
  } as Job;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  const videoProcessingService = {
    process: jest.fn(),
    markFailed: jest.fn(),
  };
  const uploadReconcilerService = { run: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: VideoProcessingService, useValue: videoProcessingService },
        { provide: UploadReconcilerService, useValue: uploadReconcilerService },
      ],
    }).compile();
    processor = module.get(VideoProcessor);
  });

  describe('process', () => {
    it('should dispatch process-video to VideoProcessingService.process', async () => {
      await processor.process(job());

      expect(videoProcessingService.process).toHaveBeenCalledWith('video-1');
    });

    it('should dispatch cleanup-stale-uploads to UploadReconcilerService.run', async () => {
      await processor.process(job({ name: 'cleanup-stale-uploads', data: {} }));

      expect(uploadReconcilerService.run).toHaveBeenCalled();
      expect(videoProcessingService.process).not.toHaveBeenCalled();
    });

    it('should fail an unknown job name without retrying', async () => {
      await expect(
        processor.process(job({ name: 'something-else' })),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });
  });

  describe('onFailed', () => {
    it('should not mark the video failed after an intermediate attempt', async () => {
      await processor.onFailed(job({ attemptsMade: 2 }), new Error('timeout'));

      expect(videoProcessingService.markFailed).not.toHaveBeenCalled();
    });

    it('should mark the video failed once attempts are exhausted', async () => {
      const err = new Error('timeout');

      await processor.onFailed(job({ attemptsMade: 3 }), err);

      expect(videoProcessingService.markFailed).toHaveBeenCalledWith(
        'video-1',
        err,
      );
    });

    it('should mark the video failed on the first attempt for an unrecoverable media error', async () => {
      const err = new MediaUnrecoverableError('NOT_A_VIDEO');

      await processor.onFailed(job({ attemptsMade: 1 }), err);

      expect(videoProcessingService.markFailed).toHaveBeenCalledWith(
        'video-1',
        err,
      );
    });

    it('should ignore failures of other job names', async () => {
      await processor.onFailed(
        job({ name: 'cleanup-stale-uploads', attemptsMade: 3 }),
        new Error('boom'),
      );

      expect(videoProcessingService.markFailed).not.toHaveBeenCalled();
    });
  });
});
