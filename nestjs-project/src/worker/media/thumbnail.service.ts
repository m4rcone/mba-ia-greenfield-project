import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  FFMPEG_TIMEOUT_MS,
  THUMBNAIL_MAX_BUFFER_BYTES,
  THUMBNAIL_MAX_OFFSET_SECONDS,
  THUMBNAIL_OFFSET_RATIO,
} from './media.constants';

const execFileAsync = promisify(execFile);

@Injectable()
export class ThumbnailService {
  /** One JPEG frame at `min(1s, duration * 0.1)`, so very short videos still get a frame. */
  async extractFrame(url: string, durationSeconds: number): Promise<Buffer> {
    const offset = Math.min(
      THUMBNAIL_MAX_OFFSET_SECONDS,
      durationSeconds * THUMBNAIL_OFFSET_RATIO,
    );
    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        offset.toFixed(3),
        '-i',
        url,
        '-frames:v',
        '1',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        '-q:v',
        '3',
        'pipe:1',
      ],
      {
        encoding: 'buffer',
        timeout: FFMPEG_TIMEOUT_MS,
        maxBuffer: THUMBNAIL_MAX_BUFFER_BYTES,
      },
    );
    if (stdout.length === 0) {
      throw new Error(`ffmpeg produced no frame at ${offset}s`);
    }
    return stdout;
  }
}
