import { ApiProperty } from '@nestjs/swagger';
import { VideoProcessingStatus, VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aB3dE5gH7jK' })
  public_id: string;

  @ApiProperty({ example: 'my-video' })
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ enum: VideoProcessingStatus })
  processing_status: VideoProcessingStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'NOT_A_VIDEO | UNSUPPORTED_CONTAINER | UNSUPPORTED_CODEC | CORRUPT_MEDIA | PROCESSING_FAILED | UPLOAD_SIZE_MISMATCH | UPLOAD_CANCELLED | UPLOAD_ABANDONED; null unless failed',
  })
  processing_error: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 12.345 })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Public URL of the thumbnail (anonymous read); null until processing_status=ready',
  })
  thumbnail_url: string | null;
}
