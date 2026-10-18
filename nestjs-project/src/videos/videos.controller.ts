import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PresignPartsDto } from './dto/presign-parts.dto';
import {
  CompleteUploadResponseDto,
  InitiateUploadResponseDto,
  PresignPartsResponseDto,
  UploadedPartsResponseDto,
} from './dto/upload-responses.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { type PlaybackMode, VideosService } from './videos.service';

function ApiErrorResponse(status: number, description: string) {
  return ApiResponse({
    status,
    description,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  });
}

const VIDEO_ID_PARAM = new ParseUUIDPipe();

// Only auth endpoints are rate-limited (Phase 02); a large upload issues many part requests.
@SkipThrottle()
@ApiTags('videos')
@ApiBearerAuth('access-token')
@ApiErrorResponse(401, 'Missing or invalid access token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and opens a multipart upload in storage. ' +
      'Video bytes never pass through the API: upload each part to the URLs from ' +
      '`POST /videos/{id}/upload/parts`.',
  })
  @ApiBody({ type: InitiateUploadDto })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: InitiateUploadResponseDto,
  })
  @ApiErrorResponse(
    400,
    'VALIDATION_ERROR (schema) or UNSUPPORTED_VIDEO_FORMAT (extension/contentType outside the allowlist or disagreeing)',
  )
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    const video = await this.videosService.initiateUpload(user.sub, dto);
    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      processing_status: video.processing_status,
      partSize: video.part_size,
      partCount: video.part_count,
    };
  }

  @Post(':id/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get presigned URLs for upload parts',
    description:
      'Returns one presigned `PUT` URL per requested part number. The `ETag` response header of each part upload is not needed by the API.',
  })
  @ApiBody({ type: PresignPartsDto })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: PresignPartsResponseDto,
  })
  @ApiErrorResponse(
    400,
    'VALIDATION_ERROR (schema/path) or INVALID_PART_NUMBER (part number above partCount)',
  )
  @ApiErrorResponse(404, 'VIDEO_NOT_FOUND — missing video or not the owner')
  @ApiErrorResponse(409, 'UPLOAD_NOT_IN_PROGRESS')
  async presignParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', VIDEO_ID_PARAM) id: string,
    @Body() dto: PresignPartsDto,
  ): Promise<PresignPartsResponseDto> {
    return this.videosService.presignParts(id, user.sub, dto.partNumbers);
  }

  @Get(':id/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description: 'Lists the parts already stored, to resume an upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload progress',
    type: UploadedPartsResponseDto,
  })
  @ApiErrorResponse(400, 'VALIDATION_ERROR — invalid UUID')
  @ApiErrorResponse(404, 'VIDEO_NOT_FOUND — missing video or not the owner')
  @ApiErrorResponse(409, 'UPLOAD_NOT_IN_PROGRESS')
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', VIDEO_ID_PARAM) id: string,
  ): Promise<UploadedPartsResponseDto> {
    return this.videosService.listUploadedParts(id, user.sub);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Completes the multipart upload from the parts stored in storage, checks the size and queues processing.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing queued',
    type: CompleteUploadResponseDto,
  })
  @ApiErrorResponse(
    400,
    'VALIDATION_ERROR (invalid UUID) or UPLOAD_SIZE_MISMATCH (stored size differs from fileSize; the video is marked failed)',
  )
  @ApiErrorResponse(404, 'VIDEO_NOT_FOUND — missing video or not the owner')
  @ApiErrorResponse(
    409,
    'UPLOAD_NOT_IN_PROGRESS or UPLOAD_INCOMPLETE (stored parts do not cover 1..partCount)',
  )
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', VIDEO_ID_PARAM) id: string,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.videosService.completeUpload(id, user.sub);
    return {
      id: video.id,
      public_id: video.public_id,
      processing_status: video.processing_status,
    };
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cancel the upload',
    description:
      'Aborts the multipart upload and marks the video failed with UPLOAD_CANCELLED.',
  })
  @ApiResponse({ status: 204, description: 'Upload cancelled' })
  @ApiErrorResponse(400, 'VALIDATION_ERROR — invalid UUID')
  @ApiErrorResponse(404, 'VIDEO_NOT_FOUND — missing video or not the owner')
  @ApiErrorResponse(409, 'UPLOAD_NOT_IN_PROGRESS')
  async cancelUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', VIDEO_ID_PARAM) id: string,
  ): Promise<void> {
    await this.videosService.cancelUpload(id, user.sub);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Owner-only read of the processing state and extracted metadata. `thumbnail_url` is null until the video is ready.',
  })
  @ApiResponse({
    status: 200,
    description: 'The video',
    type: VideoResponseDto,
  })
  @ApiErrorResponse(400, 'VALIDATION_ERROR — invalid UUID')
  @ApiErrorResponse(404, 'VIDEO_NOT_FOUND — missing video or not the owner')
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('id', VIDEO_ID_PARAM) id: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getOwnedVideo(id, user.sub);
  }

  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a short-lived presigned URL of the original file; storage answers Range requests (206). ' +
      'Only for ready videos.',
  })
  @ApiResponse({
    status: 302,
    description:
      'Redirect to the presigned URL (`Location`), `Cache-Control: no-store`',
  })
  @ApiErrorResponse(
    404,
    'VIDEO_NOT_FOUND — malformed publicId, missing video or not the owner',
  )
  @ApiErrorResponse(409, 'VIDEO_NOT_READY — processing_status is not ready')
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.redirectToPlayback(res, publicId, user.sub, 'stream');
  }

  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a short-lived presigned URL that serves the original file as an attachment with its original name. ' +
      'Only for ready videos.',
  })
  @ApiResponse({
    status: 302,
    description:
      'Redirect to the presigned URL (`Location`), `Cache-Control: no-store`',
  })
  @ApiErrorResponse(
    404,
    'VIDEO_NOT_FOUND — malformed publicId, missing video or not the owner',
  )
  @ApiErrorResponse(409, 'VIDEO_NOT_READY — processing_status is not ready')
  async download(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.redirectToPlayback(res, publicId, user.sub, 'download');
  }

  private async redirectToPlayback(
    res: Response,
    publicId: string,
    userId: string,
    mode: PlaybackMode,
  ): Promise<void> {
    const url = await this.videosService.getPlaybackUrl(publicId, userId, mode);
    // The URL is short-lived and per-user; never let a cache replay it.
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(HttpStatus.FOUND, url);
  }
}
