/** Hourly, at minute 0 (6-field cron, seconds first) (TD-11). */
export const CLEANUP_STALE_UPLOADS_CRON = '0 0 * * * *';

// Bounded history for the scheduled job; nothing deduplicates on it.
export const CLEANUP_STALE_UPLOADS_JOB_OPTIONS = {
  removeOnComplete: { count: 24 },
  removeOnFail: { count: 100 },
} as const;
