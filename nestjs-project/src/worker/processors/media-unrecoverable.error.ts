import { UnrecoverableError } from 'bullmq';
import type { ProbeError } from '../../videos/video-formats';

/** Invalid media: BullMQ fails the job without retrying; `code` becomes `processing_error`. */
export class MediaUnrecoverableError extends UnrecoverableError {
  constructor(public readonly code: ProbeError) {
    super(code);
  }
}
