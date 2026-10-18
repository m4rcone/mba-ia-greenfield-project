import { registerAs } from '@nestjs/config';

export default registerAs('upload', () => ({
  maxSizeBytes: parseInt(
    process.env.UPLOAD_MAX_SIZE_BYTES || '10737418240',
    10,
  ),
  partSizeBytes: parseInt(process.env.UPLOAD_PART_SIZE_BYTES || '16777216', 10),
  abandonAfterHours: parseInt(
    process.env.UPLOAD_ABANDON_AFTER_HOURS || '24',
    10,
  ),
  processingStuckAfterMinutes: parseInt(
    process.env.PROCESSING_STUCK_AFTER_MINUTES || '60',
    10,
  ),
}));
