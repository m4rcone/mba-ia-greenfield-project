export const PART_COUNT_LIMIT = 10_000; // S3 maximum parts per multipart upload
export const MIB = 1024 * 1024;
export const PUBLIC_ID_MAX_ATTEMPTS = 5;

/** Values persisted on `videos.processing_error` (always with processing_status=failed). */
export const VIDEO_PROCESSING_ERRORS = {
  UPLOAD_SIZE_MISMATCH: 'UPLOAD_SIZE_MISMATCH',
  UPLOAD_CANCELLED: 'UPLOAD_CANCELLED',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  UPLOAD_ABANDONED: 'UPLOAD_ABANDONED',
} as const;

export function originalObjectKey(videoId: string): string {
  return `videos/${videoId}/original`;
}

export function thumbnailPrefix(videoId: string): string {
  return `thumbnails/${videoId}/`;
}

/** Deterministic: re-processing overwrites the same object instead of adding one. */
export function thumbnailObjectKey(videoId: string): string {
  return `${thumbnailPrefix(videoId)}default.jpg`;
}
