import { PutBucketPolicyCommand, type S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createMinioTestClient,
  createTestBucket,
  deleteTestBucket,
  testBucketName,
} from '../src/test/minio';
import { obliterateTestQueue, testQueuePrefix } from '../src/test/redis';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';
import { registerConfirmAndLogin } from './utils/e2e-auth';

const ORIGINAL_FILENAME = 'vídeo de férias.mp4';
const FILE_SIZE = 2048;
// Minimal JPEG markers (SOI + EOI): storage only needs bytes and a content type.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

interface VideoBody {
  id: string;
  public_id: string;
  status: string;
  processing_status: string;
  processing_error: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  thumbnail_url: string | null;
}

describe('Videos playback (e2e)', () => {
  const videosBucket = testBucketName('playback-videos');
  const thumbnailsBucket = testBucketName('playback-thumbs');
  const overriddenEnv = {
    BULLMQ_PREFIX: testQueuePrefix(),
    S3_BUCKET_VIDEOS: videosBucket,
    S3_BUCKET_THUMBNAILS: thumbnailsBucket,
    // Presigned/public URLs are fetched from inside the container.
    S3_PUBLIC_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://minio:9000',
  };
  const previousEnv: Record<string, string | undefined> = {};
  let s3: S3Client;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(overriddenEnv)) {
      previousEnv[key] = process.env[key];
      process.env[key] = value;
    }
    s3 = createMinioTestClient();
    await createTestBucket(s3, videosBucket);
    await createTestBucket(s3, thumbnailsBucket);
    // Same policy file `minio-init` applies to the real thumbnails bucket.
    const policy = readFileSync(
      join(__dirname, '../minio/thumbnails-anonymous-policy.json'),
      'utf8',
    ).replace(
      /arn:aws:s3:::thumbnails(?=[/"])/g,
      `arn:aws:s3:::${thumbnailsBucket}`,
    );
    await s3.send(
      new PutBucketPolicyCommand({ Bucket: thumbnailsBucket, Policy: policy }),
    );

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storageService = moduleFixture.get(StorageService);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await obliterateTestQueue(queue);
    await app.close();
    await deleteTestBucket(s3, videosBucket);
    await deleteTestBucket(s3, thumbnailsBucket);
    s3.destroy();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function initiateUpload(
    token: string,
  ): Promise<{ id: string; public_id: string }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .auth(token, { type: 'bearer' })
      .send({
        fileName: ORIGINAL_FILENAME,
        contentType: 'video/mp4',
        fileSize: FILE_SIZE,
      })
      .expect(201);
    return res.body as { id: string; public_id: string };
  }

  async function uploadAndComplete(token: string, id: string): Promise<void> {
    const parts = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/parts`)
      .auth(token, { type: 'bearer' })
      .send({ partNumbers: [1] })
      .expect(200);
    const { url } = (parts.body as { parts: { url: string }[] }).parts[0];
    const stored = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(FILE_SIZE).map((_, i) => i % 256),
    });
    expect(stored.status).toBe(200);
    await request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .auth(token, { type: 'bearer' })
      .expect(202);
  }

  /** Real upload flow up to `processing` (the worker does not run in E2E). */
  async function createProcessingVideo(
    token: string,
  ): Promise<{ id: string; public_id: string }> {
    const video = await initiateUpload(token);
    await uploadAndComplete(token, video.id);
    return video;
  }

  /** Does what the worker would: metadata + thumbnail object + `ready`. */
  async function promoteToReady(id: string): Promise<void> {
    const thumbnailKey = `thumbnails/${id}/default.jpg`;
    await storageService.putObject(
      thumbnailsBucket,
      thumbnailKey,
      JPEG_BYTES,
      'image/jpeg',
    );
    await videoRepository.update(
      { id },
      {
        processing_status: VideoProcessingStatus.READY,
        duration_seconds: 12.345,
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        thumbnail_key: thumbnailKey,
      },
    );
  }

  async function getVideo(token: string, id: string): Promise<VideoBody> {
    const res = await request(app.getHttpServer())
      .get(`/videos/${id}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    return res.body as VideoBody;
  }

  // 1. Consulta, streaming e download do vídeo pelo dono

  it('get-video-antes-de-ready-tem-thumbnail-nula', async () => {
    const token = await registerConfirmAndLogin(app);
    const { id } = await initiateUpload(token);

    expect(await getVideo(token, id)).toMatchObject({
      processing_status: 'uploading',
      status: 'draft',
      thumbnail_url: null,
    });

    await uploadAndComplete(token, id);

    expect(await getVideo(token, id)).toMatchObject({
      processing_status: 'processing',
      thumbnail_url: null,
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
    });
  });

  it('get-video-ready-expoe-metadados-e-thumbnail-publica', async () => {
    const token = await registerConfirmAndLogin(app);
    const { id } = await createProcessingVideo(token);
    await promoteToReady(id);

    const body = await getVideo(token, id);

    expect(body).toMatchObject({
      processing_status: 'ready',
      processing_error: null,
      duration_seconds: 12.345,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
    });
    expect(body.thumbnail_url).toBe(
      `${overriddenEnv.S3_PUBLIC_ENDPOINT}/${thumbnailsBucket}/thumbnails/${id}/default.jpg`,
    );
    const thumbnail = await fetch(body.thumbnail_url!);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toMatch(/^image\//);
  });

  it('bucket-de-thumbnails-nao-permite-listagem-anonima', async () => {
    const token = await registerConfirmAndLogin(app);
    const { id } = await createProcessingVideo(token);
    await promoteToReady(id);

    // A listing would expose every thumbnail key, and so every video UUID.
    const listing = await fetch(
      `${overriddenEnv.S3_PUBLIC_ENDPOINT}/${thumbnailsBucket}/`,
    );

    expect(listing.status).toBe(403);
  });

  it('stream-redireciona-e-storage-atende-range', async () => {
    const token = await registerConfirmAndLogin(app);
    const { id, public_id } = await createProcessingVideo(token);
    await promoteToReady(id);

    const res = await request(app.getHttpServer())
      .get(`/videos/${public_id}/stream`)
      .auth(token, { type: 'bearer' })
      .expect(302);

    expect(res.headers['cache-control']).toBe('no-store');
    const location = new URL(res.headers.location);
    expect(location.host).toBe(new URL(overriddenEnv.S3_PUBLIC_ENDPOINT).host);
    expect(location.searchParams.has('X-Amz-Signature')).toBe(true);

    const ranged = await fetch(location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(
      `bytes 0-1023/${FILE_SIZE}`,
    );
    expect((await ranged.arrayBuffer()).byteLength).toBe(1024);
  });

  it('download-redireciona-com-content-disposition-attachment', async () => {
    const token = await registerConfirmAndLogin(app);
    const { id, public_id } = await createProcessingVideo(token);
    await promoteToReady(id);

    const res = await request(app.getHttpServer())
      .get(`/videos/${public_id}/download`)
      .auth(token, { type: 'bearer' })
      .expect(302);

    expect(res.headers['cache-control']).toBe('no-store');
    const file = await fetch(res.headers.location);
    expect(file.status).toBe(200);
    const disposition = file.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment')).toBe(true);
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent(ORIGINAL_FILENAME)}`,
    );
  });

  it('stream-e-download-de-video-em-processing-retornam-409', async () => {
    const token = await registerConfirmAndLogin(app);
    const { public_id } = await createProcessingVideo(token);

    for (const mode of ['stream', 'download']) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${public_id}/${mode}`)
        .auth(token, { type: 'bearer' })
        .expect(409);
      expect(res.body).toMatchObject({ error: 'VIDEO_NOT_READY' });
    }
  });

  it('stream-publicid-malformado-inexistente-ou-alheio-retorna-404', async () => {
    const ownerToken = await registerConfirmAndLogin(app);
    const otherToken = await registerConfirmAndLogin(app);
    const { id, public_id } = await createProcessingVideo(ownerToken);
    await promoteToReady(id);

    const expectNotFound = async (path: string, token: string) => {
      const res = await request(app.getHttpServer())
        .get(path)
        .auth(token, { type: 'bearer' })
        .expect(404);
      expect(res.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    };

    await expectNotFound(
      `/videos/${encodeURIComponent('abc!')}/stream`,
      ownerToken,
    );
    await expectNotFound('/videos/zzzzzzzzzzz/stream', ownerToken);
    await expectNotFound(`/videos/${public_id}/stream`, otherToken);
    await expectNotFound(`/videos/${id}`, otherToken);
  });

  it('rotas-sem-token-retornam-401', async () => {
    const server = app.getHttpServer();

    await request(server).get(`/videos/${randomUUID()}`).expect(401);
    await request(server).get('/videos/aB3dE5gH7jK/stream').expect(401);
    await request(server).get('/videos/aB3dE5gH7jK/download').expect(401);
  });
});
