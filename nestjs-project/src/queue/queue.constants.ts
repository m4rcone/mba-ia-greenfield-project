import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';

export const VIDEO_PROCESSING_JOBS = {
  PROCESS_VIDEO: 'process-video',
  CLEANUP_STALE_UPLOADS: 'cleanup-stale-uploads',
} as const;

export type ProcessVideoJobData = { videoId: string };

// Retention must outlive PROCESSING_STUCK_AFTER_MINUTES so a retained job keeps
// deduplicating by jobId when the reconciler re-enqueues (TD-06, TD-11).
export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const satisfies JobsOptions;
