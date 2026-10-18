import { extname } from 'node:path';

export interface VideoFormat {
  extensions: readonly string[];
  contentType: string;
  formatName: string;
  videoCodecs: readonly string[];
  audioCodecs: readonly string[];
}

// TD-14 allowlist, shared by the initiate validator (declared format) and the worker (probed format).
export const VIDEO_FORMATS: readonly VideoFormat[] = [
  {
    extensions: ['.mp4', '.m4v'],
    contentType: 'video/mp4',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodecs: ['h264', 'av1'],
    audioCodecs: ['aac', 'mp3'],
  },
  {
    extensions: ['.mov'],
    contentType: 'video/quicktime',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
  },
  {
    extensions: ['.webm'],
    contentType: 'video/webm',
    formatName: 'matroska,webm',
    videoCodecs: ['vp8', 'vp9', 'av1'],
    audioCodecs: ['opus', 'vorbis'],
  },
] as const;

export function resolveContentTypeFromFileName(
  fileName: string,
): string | null {
  const extension = extname(fileName).toLowerCase();
  const format = VIDEO_FORMATS.find((f) => f.extensions.includes(extension));
  return format?.contentType ?? null;
}

export function isDeclaredFormatAllowed(
  fileName: string,
  contentType: string,
): boolean {
  const resolved = resolveContentTypeFromFileName(fileName);
  return resolved !== null && resolved === contentType.toLowerCase();
}

// Subset of `ffprobe -print_format json -show_format -show_streams` output consumed here.
export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  disposition?: { attached_pic?: number };
}

export interface ProbeResult {
  format?: { format_name?: string; duration?: string | number };
  streams?: ProbeStream[];
}

export type ProbeError =
  | 'NOT_A_VIDEO'
  | 'UNSUPPORTED_CONTAINER'
  | 'UNSUPPORTED_CODEC'
  | 'CORRUPT_MEDIA';

export interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
}

export type ProbeValidation =
  | { ok: true; metadata: VideoMetadata }
  | { ok: false; error: ProbeError };

// Still-image demuxers (e.g. a PNG renamed to .mp4 probes as `png_pipe`) expose the
// picture as a "video" stream; such files are not videos.
function isStillImageFormat(formatName: string | undefined): boolean {
  return (
    formatName !== undefined &&
    (formatName === 'image2' || formatName.endsWith('_pipe'))
  );
}

export function validateProbe(probe: ProbeResult): ProbeValidation {
  const streams = isStillImageFormat(probe.format?.format_name)
    ? []
    : (probe.streams ?? []);
  const videoStream = streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1,
  );
  if (!videoStream) {
    return { ok: false, error: 'NOT_A_VIDEO' };
  }

  // ffprobe reports the same format_name for .mp4 and .mov, so codecs are the union of
  // every allowlist entry sharing the probed container.
  const formats = VIDEO_FORMATS.filter(
    (f) => f.formatName === probe.format?.format_name,
  );
  if (formats.length === 0) {
    return { ok: false, error: 'UNSUPPORTED_CONTAINER' };
  }

  const videoCodec = videoStream.codec_name?.toLowerCase() ?? '';
  const audioCodec =
    streams.find((s) => s.codec_type === 'audio')?.codec_name?.toLowerCase() ??
    null;
  const videoCodecAllowed = formats.some((f) =>
    f.videoCodecs.includes(videoCodec),
  );
  const audioCodecAllowed =
    audioCodec === null ||
    formats.some((f) => f.audioCodecs.includes(audioCodec));
  if (!videoCodecAllowed || !audioCodecAllowed) {
    return { ok: false, error: 'UNSUPPORTED_CODEC' };
  }

  const durationSeconds = Number(probe.format?.duration);
  const { width = 0, height = 0 } = videoStream;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    width <= 0 ||
    height <= 0
  ) {
    return { ok: false, error: 'CORRUPT_MEDIA' };
  }

  return {
    ok: true,
    metadata: { durationSeconds, width, height, videoCodec, audioCodec },
  };
}
