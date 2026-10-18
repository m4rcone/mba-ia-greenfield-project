import type { S3Client } from '@aws-sdk/client-s3';
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
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createMinioTestClient,
  createTestBucket,
  deleteTestBucket,
  testBucketName,
} from '../src/test/minio';
import { obliterateTestQueue, testQueuePrefix } from '../src/test/redis';
import { Video } from '../src/videos/entities/video.entity';
import { registerConfirmAndLogin } from './utils/e2e-auth';

interface InitiateBody {
  id: string;
  public_id: string;
  title: string;
  status: string;
  processing_status: string;
  partSize: number;
  partCount: number;
}

interface PresignBody {
  parts: { partNumber: number; url: string }[];
  expiresIn: number;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
}

describe('Videos upload (e2e)', () => {
  const bucket = testBucketName('videos-e2e');
  const overriddenEnv = {
    BULLMQ_PREFIX: testQueuePrefix(),
    S3_BUCKET_VIDEOS: bucket,
    // Parts are PUT from inside the container, so URLs must be signed for minio:9000.
    S3_PUBLIC_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://minio:9000',
  };
  const previousEnv: Record<string, string | undefined> = {};
  let s3: S3Client;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(overriddenEnv)) {
      previousEnv[key] = process.env[key];
      process.env[key] = value;
    }
    s3 = createMinioTestClient();
    await createTestBucket(s3, bucket);

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
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await obliterateTestQueue(queue);
    await app.close();
    await deleteTestBucket(s3, bucket);
    s3.destroy();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await obliterateTestQueue(queue);
    throttlerStorage.storage.clear();
  });

  async function initiate(
    accessToken: string,
    body: { fileName: string; contentType: string; fileSize: number },
  ): Promise<InitiateBody> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .auth(accessToken, { type: 'bearer' })
      .send(body)
      .expect(201);
    return res.body as InitiateBody;
  }

  async function presign(
    accessToken: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<PresignBody> {
    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/parts`)
      .auth(accessToken, { type: 'bearer' })
      .send({ partNumbers })
      .expect(200);
    return res.body as PresignBody;
  }

  async function putPart(url: string, bytes: number): Promise<Response> {
    return fetch(url, { method: 'PUT', body: new Uint8Array(bytes) });
  }

  // 1. Upload multipart — initiate, parts, complete, cancel

  it('initiate-grande-retorna-201-com-particionamento', async () => {
    const token = await registerConfirmAndLogin(app);

    const body = await initiate(token, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      fileSize: 10737418240,
    });

    expect(body).toMatchObject({
      title: 'clip',
      status: 'draft',
      processing_status: 'uploading',
      partSize: 16777216,
      partCount: 640,
    });
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.public_id).toMatch(/^[0-9A-Za-z]{11}$/);
    const row = await videoRepository.findOneByOrFail({ id: body.id });
    expect(row.upload_id).not.toBeNull();
    expect(row.part_size).toBe(16777216);
    expect(row.part_count).toBe(640);
  });

  it('initiate-rejeita-formato-e-validacao', async () => {
    const token = await registerConfirmAndLogin(app);

    const unsupported = await request(app.getHttpServer())
      .post('/videos')
      .auth(token, { type: 'bearer' })
      .send({ fileName: 'clip.avi', contentType: 'video/mp4', fileSize: 1024 })
      .expect(400);
    expect(unsupported.body).toMatchObject({
      error: 'UNSUPPORTED_VIDEO_FORMAT',
    });

    const invalid = await request(app.getHttpServer())
      .post('/videos')
      .auth(token, { type: 'bearer' })
      .send({ fileName: 'clip.mp4', contentType: 'video/mp4', fileSize: 0 })
      .expect(400);
    expect(invalid.body).toMatchObject({ error: 'VALIDATION_ERROR' });

    expect(await videoRepository.count()).toBe(0);
  });

  it('presign-parts-retorna-urls-publicas-e-valida-part-number', async () => {
    const token = await registerConfirmAndLogin(app);
    const { id, partSize, partCount } = await initiate(token, {
      fileName: 'clip.webm',
      contentType: 'video/webm',
      fileSize: 2 * 16777216,
    });
    expect(partSize).toBe(16777216);
    expect(partCount).toBeGreaterThanOrEqual(2);

    const { parts, expiresIn } = await presign(token, id, [1, 2]);

    expect(expiresIn).toBe(900);
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
    const publicHost = new URL(overriddenEnv.S3_PUBLIC_ENDPOINT).host;
    for (const part of parts) {
      expect(new URL(part.url).host).toBe(publicHost);
    }

    const tooHigh = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/parts`)
      .auth(token, { type: 'bearer' })
      .send({ partNumbers: [partCount + 1] })
      .expect(400);
    expect(tooHigh.body).toMatchObject({ error: 'INVALID_PART_NUMBER' });
  });

  it('list-uploaded-parts-reflete-parte-enviada', async () => {
    const token = await registerConfirmAndLogin(app);
    const { id, partSize, partCount } = await initiate(token, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      fileSize: 2 * 16777216,
    });
    const { parts } = await presign(token, id, [1]);

    const stored = await putPart(parts[0].url, 1024);
    expect(stored.status).toBe(200);
    expect(stored.headers.get('etag')).toBeTruthy();

    const res = await request(app.getHttpServer())
      .get(`/videos/${id}/upload/parts`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.body).toEqual({
      partSize,
      partCount,
      uploadedParts: [{ partNumber: 1, size: 1024 }],
    });
  });

  it('complete-enfileira-e-repeticao-retorna-409', async () => {
    const token = await registerConfirmAndLogin(app);
    const fileSize = 1024;
    const { id, public_id } = await initiate(token, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      fileSize,
    });
    const { parts } = await presign(token, id, [1]);
    expect((await putPart(parts[0].url, fileSize)).status).toBe(200);

    const completed = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .auth(token, { type: 'bearer' })
      .expect(202);

    expect(completed.body).toEqual({
      id,
      public_id,
      processing_status: 'processing',
    });
    const row = await videoRepository.findOneByOrFail({ id });
    expect(row.processing_status).toBe('processing');
    expect(row.upload_id).toBeNull();
    const job = await queue.getJob(id);
    expect(job?.name).toBe('process-video');

    const repeated = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .auth(token, { type: 'bearer' })
      .expect(409);
    expect(repeated.body).toMatchObject({ error: 'UPLOAD_NOT_IN_PROGRESS' });
  });

  it('cancel-retorna-204-e-nao-dono-recebe-404', async () => {
    const ownerToken = await registerConfirmAndLogin(app);
    const otherToken = await registerConfirmAndLogin(app);
    const { id } = await initiate(ownerToken, {
      fileName: 'clip.mov',
      contentType: 'video/quicktime',
      fileSize: 1024,
    });

    const notOwner = await request(app.getHttpServer())
      .delete(`/videos/${id}/upload`)
      .auth(otherToken, { type: 'bearer' })
      .expect(404);
    expect(notOwner.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    expect(
      (await videoRepository.findOneByOrFail({ id })).processing_status,
    ).toBe('uploading');

    const cancelled = await request(app.getHttpServer())
      .delete(`/videos/${id}/upload`)
      .auth(ownerToken, { type: 'bearer' })
      .expect(204);

    expect(cancelled.text).toBe('');
    const row = await videoRepository.findOneByOrFail({ id });
    expect(row).toMatchObject({
      processing_status: 'failed',
      processing_error: 'UPLOAD_CANCELLED',
      upload_id: null,
    });
  });

  it('rotas-sem-token-retornam-401', async () => {
    const id = randomUUID();
    const server = app.getHttpServer();

    await request(server).post('/videos').send({}).expect(401);
    await request(server)
      .post(`/videos/${id}/upload/parts`)
      .send({ partNumbers: [1] })
      .expect(401);
    await request(server).get(`/videos/${id}/upload/parts`).expect(401);
    await request(server).post(`/videos/${id}/upload/complete`).expect(401);
    await request(server).delete(`/videos/${id}/upload`).expect(401);
  });

  it('openapi-contem-operacoes-de-upload', () => {
    const document = JSON.parse(
      readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8'),
    ) as OpenApiDocument;
    const statuses = (path: string, method: string) =>
      Object.keys(document.paths[path]?.[method]?.responses ?? {});

    expect(statuses('/videos', 'post')).toEqual(
      expect.arrayContaining(['201', '400', '401']),
    );
    expect(statuses('/videos/{id}/upload/parts', 'post')).toEqual(
      expect.arrayContaining(['200', '400', '401', '404', '409']),
    );
    expect(statuses('/videos/{id}/upload/parts', 'get')).toEqual(
      expect.arrayContaining(['200', '400', '401', '404', '409']),
    );
    expect(statuses('/videos/{id}/upload/complete', 'post')).toEqual(
      expect.arrayContaining(['202', '400', '401', '404', '409']),
    );
    expect(statuses('/videos/{id}/upload', 'delete')).toEqual(
      expect.arrayContaining(['204', '400', '401', '404', '409']),
    );
  });
});
