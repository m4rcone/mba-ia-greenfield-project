export const FFPROBE_TIMEOUT_MS = 60_000;
export const FFMPEG_TIMEOUT_MS = 120_000;
export const FFPROBE_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
export const THUMBNAIL_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
export const THUMBNAIL_MAX_OFFSET_SECONDS = 1;
export const THUMBNAIL_OFFSET_RATIO = 0.1;

/** ffprobe stderr fragments that mean the input bytes are not parseable media. */
export const CORRUPT_MEDIA_PATTERNS = [
  /Invalid data found when processing input/i,
  /moov atom not found/i,
];
