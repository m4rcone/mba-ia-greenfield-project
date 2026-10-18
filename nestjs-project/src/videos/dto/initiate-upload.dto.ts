import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  Length,
  Min,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import uploadConfig from '../../config/upload.config';

// Read per validation, not at decoration time: `.env` reaches process.env only when
// ConfigModule boots, after this module is imported.
function MaxUploadSize(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'maxUploadSize',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'number' && value <= uploadConfig().maxSizeBytes,
        defaultMessage: () =>
          `fileSize must not be greater than ${uploadConfig().maxSizeBytes}`,
      },
    },
    options,
  );
}

export class InitiateUploadDto {
  @ApiProperty({
    example: 'my-video.mp4',
    minLength: 1,
    maxLength: 255,
    description: 'Extension must be one of .mp4, .m4v, .mov, .webm',
  })
  @IsString()
  @Length(1, 255)
  fileName: string;

  @ApiProperty({
    example: 'video/mp4',
    enum: ['video/mp4', 'video/quicktime', 'video/webm'],
    description: 'Must agree with the fileName extension',
  })
  @IsString()
  contentType: string;

  @ApiProperty({
    example: 10737418240,
    minimum: 1,
    description:
      'Size in bytes, at most UPLOAD_MAX_SIZE_BYTES (default 10 GiB)',
  })
  @IsInt()
  @Min(1)
  @MaxUploadSize()
  fileSize: number;
}
