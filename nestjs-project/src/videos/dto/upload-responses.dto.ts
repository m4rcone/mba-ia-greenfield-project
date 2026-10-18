import { ApiProperty } from '@nestjs/swagger';
import { VideoProcessingStatus, VideoStatus } from '../entities/video.entity';

export class InitiateUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aB3dE5gH7jK', pattern: '^[0-9A-Za-z]{11}$' })
  public_id: string;

  @ApiProperty({ example: 'my-video' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({
    enum: VideoProcessingStatus,
    example: VideoProcessingStatus.UPLOADING,
  })
  processing_status: VideoProcessingStatus;

  @ApiProperty({ example: 16777216, description: 'Bytes per part' })
  partSize: number;

  @ApiProperty({ example: 640 })
  partCount: number;
}

export class PresignedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ description: 'Presigned UploadPart URL (HTTP PUT)' })
  url: string;
}

export class PresignPartsResponseDto {
  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];

  @ApiProperty({ example: 900, description: 'URL TTL in seconds' })
  expiresIn: number;
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ example: 16777216 })
  size: number;
}

export class UploadedPartsResponseDto {
  @ApiProperty({ example: 16777216 })
  partSize: number;

  @ApiProperty({ example: 640 })
  partCount: number;

  @ApiProperty({ type: [UploadedPartDto] })
  uploadedParts: UploadedPartDto[];
}

export class CompleteUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aB3dE5gH7jK' })
  public_id: string;

  @ApiProperty({
    enum: VideoProcessingStatus,
    example: VideoProcessingStatus.PROCESSING,
  })
  processing_status: VideoProcessingStatus;
}
