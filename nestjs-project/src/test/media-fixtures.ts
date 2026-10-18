import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MEDIA_FIXTURES_DIR = join(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'media',
);

/** Small media files generated with ffmpeg (lavfi test sources), see test/fixtures/media. */
export const MEDIA_FIXTURES = {
  VALID_H264_AAC_MP4: 'valid-h264-aac.mp4', // 2 s, 320x240
  VALID_VP9_OPUS_WEBM: 'valid-vp9-opus.webm', // 1 s, 320x240
  SHORT_H264_MP4: 'short-0_5s.mp4', // 0.5 s, 160x120, no audio
  TRUNCATED_MP4: 'truncated.mp4', // first 20 KB of the valid mp4 (no moov atom)
  PNG_RENAMED_MP4: 'png-renamed.mp4', // a PNG image with a .mp4 name
  UNSUPPORTED_CODEC_MKV: 'unsupported-codec.mkv', // matroska with mpeg4 video
} as const;

export async function uploadMediaFixture(
  client: S3Client,
  bucket: string,
  fileName: string,
): Promise<string> {
  const key = `fixtures/${fileName}`;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: readFileSync(join(MEDIA_FIXTURES_DIR, fileName)),
    }),
  );
  return key;
}
