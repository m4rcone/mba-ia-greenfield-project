import {
  isDeclaredFormatAllowed,
  type ProbeResult,
  type ProbeStream,
  resolveContentTypeFromFileName,
  validateProbe,
} from './video-formats';

const MP4_FORMAT = 'mov,mp4,m4a,3gp,3g2,mj2';
const WEBM_FORMAT = 'matroska,webm';

function videoStream(overrides: Partial<ProbeStream> = {}): ProbeStream {
  return {
    codec_type: 'video',
    codec_name: 'h264',
    width: 1920,
    height: 1080,
    disposition: { attached_pic: 0 },
    ...overrides,
  };
}

function audioStream(codecName: string): ProbeStream {
  return { codec_type: 'audio', codec_name: codecName };
}

function probe(
  formatName: string,
  streams: ProbeStream[],
  duration: string | null = '12.345000',
): ProbeResult {
  // null omits the field (an `undefined` argument would fall back to the default)
  return {
    format: { format_name: formatName, ...(duration !== null && { duration }) },
    streams,
  };
}

describe('video-formats', () => {
  describe('resolveContentTypeFromFileName', () => {
    it.each([
      ['movie.mp4', 'video/mp4'],
      ['movie.M4V', 'video/mp4'],
      ['movie.MOV', 'video/quicktime'],
      ['movie.webm', 'video/webm'],
      ['archive.tar.webm', 'video/webm'],
    ])('should resolve %s to %s', (fileName, contentType) => {
      expect(resolveContentTypeFromFileName(fileName)).toBe(contentType);
    });

    it.each(['movie.avi', 'movie.mkv', 'movie', 'mp4'])(
      'should return null for %s',
      (fileName) => {
        expect(resolveContentTypeFromFileName(fileName)).toBeNull();
      },
    );
  });

  describe('isDeclaredFormatAllowed', () => {
    it.each([
      ['clip.MOV', 'video/quicktime'],
      ['clip.mp4', 'video/mp4'],
      ['clip.m4v', 'video/mp4'],
      ['clip.webm', 'video/webm'],
      ['clip.mp4', 'VIDEO/MP4'],
    ])('should allow %s declared as %s', (fileName, contentType) => {
      expect(isDeclaredFormatAllowed(fileName, contentType)).toBe(true);
    });

    it.each([
      ['clip.mov', 'video/mp4'],
      ['clip.mp4', 'video/quicktime'],
      ['clip.webm', 'video/mp4'],
      ['clip.avi', 'video/x-msvideo'],
      ['clip.avi', 'video/mp4'],
    ])('should reject %s declared as %s', (fileName, contentType) => {
      expect(isDeclaredFormatAllowed(fileName, contentType)).toBe(false);
    });
  });

  describe('validateProbe', () => {
    it('should accept an mp4 with h264/aac and return its metadata', () => {
      const result = validateProbe(
        probe(MP4_FORMAT, [videoStream(), audioStream('aac')]),
      );

      expect(result).toEqual({
        ok: true,
        metadata: {
          durationSeconds: 12.345,
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          audioCodec: 'aac',
        },
      });
    });

    it('should accept a video without audio and report audioCodec null', () => {
      const result = validateProbe(
        probe(WEBM_FORMAT, [videoStream({ codec_name: 'vp9' })]),
      );

      expect(result).toMatchObject({
        ok: true,
        metadata: { videoCodec: 'vp9', audioCodec: null },
      });
    });

    it.each([
      [MP4_FORMAT, 'h264', 'aac'],
      [MP4_FORMAT, 'av1', 'mp3'],
      [WEBM_FORMAT, 'vp8', 'vorbis'],
      [WEBM_FORMAT, 'av1', 'opus'],
    ])('should accept %s with %s/%s', (formatName, video, audio) => {
      const result = validateProbe(
        probe(formatName, [
          videoStream({ codec_name: video }),
          audioStream(audio),
        ]),
      );

      expect(result.ok).toBe(true);
    });

    it('should reject with NOT_A_VIDEO when there is no video stream', () => {
      const result = validateProbe(probe(MP4_FORMAT, [audioStream('aac')]));

      expect(result).toEqual({ ok: false, error: 'NOT_A_VIDEO' });
    });

    it('should reject with NOT_A_VIDEO when the only video stream is an attached picture', () => {
      const result = validateProbe(
        probe(MP4_FORMAT, [
          videoStream({
            codec_name: 'mjpeg',
            disposition: { attached_pic: 1 },
          }),
          audioStream('aac'),
        ]),
      );

      expect(result).toEqual({ ok: false, error: 'NOT_A_VIDEO' });
    });

    it.each(['png_pipe', 'image2'])(
      'should reject with NOT_A_VIDEO when a still image (%s) exposes a video stream',
      (formatName) => {
        const result = validateProbe(
          probe(formatName, [videoStream({ codec_name: 'png' })]),
        );

        expect(result).toEqual({ ok: false, error: 'NOT_A_VIDEO' });
      },
    );

    it('should reject with UNSUPPORTED_CONTAINER for a container outside the allowlist', () => {
      const result = validateProbe(probe('avi', [videoStream()]));

      expect(result).toEqual({ ok: false, error: 'UNSUPPORTED_CONTAINER' });
    });

    it.each([
      ['a webm with h264 video', WEBM_FORMAT, 'h264', 'opus'],
      ['an mp4 with vp9 video', MP4_FORMAT, 'vp9', 'aac'],
      ['an mp4 with opus audio', MP4_FORMAT, 'h264', 'opus'],
      ['a webm with aac audio', WEBM_FORMAT, 'vp9', 'aac'],
    ])(
      'should reject %s with UNSUPPORTED_CODEC',
      (_label, formatName, video, audio) => {
        const result = validateProbe(
          probe(formatName, [
            videoStream({ codec_name: video }),
            audioStream(audio),
          ]),
        );

        expect(result).toEqual({ ok: false, error: 'UNSUPPORTED_CODEC' });
      },
    );

    it.each([
      ['missing', null],
      ['zero', '0'],
      ['negative', '-1'],
      ['not a number', 'N/A'],
    ])(
      'should reject with CORRUPT_MEDIA when duration is %s',
      (_label, duration) => {
        const result = validateProbe(
          probe(MP4_FORMAT, [videoStream()], duration),
        );

        expect(result).toEqual({ ok: false, error: 'CORRUPT_MEDIA' });
      },
    );

    it.each([
      ['width is 0', { width: 0 }],
      ['height is missing', { height: undefined }],
    ])('should reject with CORRUPT_MEDIA when %s', (_label, overrides) => {
      const result = validateProbe(probe(MP4_FORMAT, [videoStream(overrides)]));

      expect(result).toEqual({ ok: false, error: 'CORRUPT_MEDIA' });
    });
  });
});
