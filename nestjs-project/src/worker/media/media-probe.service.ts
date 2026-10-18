import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type ProbeResult,
  type VideoMetadata,
  validateProbe,
} from '../../videos/video-formats';
import {
  CORRUPT_MEDIA_PATTERNS,
  FFPROBE_MAX_BUFFER_BYTES,
  FFPROBE_TIMEOUT_MS,
} from './media.constants';
import { MediaValidationError } from './media-validation.error';

const execFileAsync = promisify(execFile);

@Injectable()
export class MediaProbeService {
  /**
   * Runs ffprobe on a (presigned) URL. Unparseable input → `CORRUPT_MEDIA`;
   * any other failure (network, timeout, storage) is rethrown as transient.
   */
  async probe(url: string): Promise<ProbeResult> {
    try {
      // execFile, never a shell: the URL is passed as a single argument.
      const { stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          url,
        ],
        { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: FFPROBE_MAX_BUFFER_BYTES },
      );
      return JSON.parse(stdout) as ProbeResult;
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? '';
      if (CORRUPT_MEDIA_PATTERNS.some((pattern) => pattern.test(stderr))) {
        throw new MediaValidationError('CORRUPT_MEDIA');
      }
      throw new Error(`ffprobe failed: ${stderr.trim() || String(err)}`, {
        cause: err,
      });
    }
  }

  async probeAndValidate(url: string): Promise<VideoMetadata> {
    const result = validateProbe(await this.probe(url));
    if (!result.ok) {
      throw new MediaValidationError(result.error);
    }
    return result.metadata;
  }
}
