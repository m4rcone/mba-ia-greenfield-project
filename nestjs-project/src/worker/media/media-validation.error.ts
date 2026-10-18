import type { ProbeError } from '../../videos/video-formats';

/**
 * The uploaded file itself is unacceptable (not a video, wrong container/codec, corrupt).
 * Permanent: retrying cannot succeed. Any other error from the media services is transient.
 */
export class MediaValidationError extends Error {
  constructor(public readonly code: ProbeError) {
    super(`Media validation failed: ${code}`);
    this.name = MediaValidationError.name;
  }
}
