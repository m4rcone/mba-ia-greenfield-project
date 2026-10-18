---
libs:
  bullmq:
    version: "^6.x"
    context7_id: "/websites/bullmq_io"
    fetched_at: "2026-10-18T00:31:20-03:00"
  "@nestjs/bullmq":
    version: "^12.x"
    context7_id: "/websites/nestjs"
    fetched_at: "2026-10-18T00:31:20-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-18T00:31:20-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-18T00:31:20-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-18T00:18:37-03:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this slice. Pulled via Context7. Re-fetch when the underlying TD changes (resolve refreshes this file when the lib set in `## Decisions Index` drifts from the cached set here).

None of these packages is installed in `nestjs-project/package.json` yet — versions above are the ranges declared in the TDs (`bullmq` v6.x, `@nestjs/bullmq` v12.x with peer `@nestjs/core ^11`, AWS SDK v3.11xx). Pin to the actual installed versions when `npm install` runs, and re-check the docs if the installed major differs.

## bullmq

**Source:** `/websites/bullmq_io` (Context7, docs.bullmq.io) — High reputation, benchmark 89.7. Maps to `phase-03-videos/TD-01` (A), `TD-06` (A), `TD-10` (A), `TD-11` (B).

### Enqueue with retries + exponential backoff (TD-10)

Exponential backoff retries after `2^(attempts-1) * delay` ms.

```typescript
await queue.add(
  'process-video',
  { videoId },
  {
    jobId: videoId, // TD-06 — idempotent re-enqueue
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
);
```

### `jobId` deduplication (TD-06 / TD-11 reconciler)

Adding a job whose `jobId` already exists is **ignored**. Caveat from the docs: if the job was already removed (`removeOnComplete` / `removeOnFail`), it no longer counts as existing and a duplicate **will** be added — so the reconciler re-enqueue is only a no-op while the previous job is still retained. The processor must stay idempotent regardless (TD-10).

BullMQ also has a separate `deduplication: { id, ttl }` option (throttle/debounce mode); TD-06 uses plain `jobId`, not this.

### Non-retryable failures (TD-10 / TD-14)

Throwing `UnrecoverableError` moves the job straight to failed, ignoring `attempts` — use it for ffprobe-rejected content (TD-14) and other permanent errors.

```typescript
import { UnrecoverableError } from 'bullmq';
throw new UnrecoverableError('unsupported container/codec');
```

### Job retention

```typescript
removeOnComplete: { age: 3600, count: 1000 },
removeOnFail: { age: 24 * 3600 },
```

`age` is in seconds; auto-removal runs lazily when another job completes/fails. Can be set as worker options or per-job / `defaultJobOptions`.

### Cleanup cron via job schedulers (TD-11)

`upsertJobScheduler` is idempotent by scheduler id — calling it on every boot updates instead of duplicating.

```typescript
await queue.upsertJobScheduler(
  'cleanup-stale-uploads',
  { pattern: '0 */15 * * * *' }, // 6-field cron (seconds first)
  { name: 'cleanup-stale-uploads', data: {}, opts: { attempts: 3, removeOnFail: 1000 } },
);
```

### Redis connection requirements

- Workers using ioredis need `maxRetriesPerRequest: null` (BullMQ sets it by default for `Worker`; overriding it emits a warning).
- Production guide: Redis must run with `maxmemory-policy noeviction` (matches TD-01 cons) — set it in the `redis` Compose service.

### Shutdown / tests (TD-13)

- `await worker.close()` — graceful: stops taking jobs, waits for current ones (no built-in timeout).
- Test isolation: `queue.obliterate({ force: true })` between specs; assert enqueue with `queue.getJob(videoId)` / `queue.getJobs()`.

## @nestjs/bullmq

**Source:** `/websites/nestjs` (docs.nestjs.com/techniques/queues) + `/nestjs/bull` (package API reference) — High reputation. Maps to `phase-03-videos/TD-01` (A), `TD-05` (A).

### Module wiring

Root connection read from the config namespace (Phase 01 `registerAs` convention), then per-queue registration:

```typescript
BullModule.forRootAsync({
  inject: [redisConfig.KEY],
  useFactory: (cfg: ConfigType<typeof redisConfig>) => ({
    connection: { host: cfg.host, port: cfg.port }, // REDIS_HOST=redis
  }),
}),
BullModule.registerQueue({
  name: 'video-processing',
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
}),
```

> **Discrepancy flag:** one Context7 snippet for `forRootAsync` comes from the legacy `@nestjs/bull` package and uses `redis: {...}`. For `@nestjs/bullmq` the option key is `connection` (BullMQ `QueueOptions`). Use `connection`.

`registerQueueAsync({ name, useFactory, inject })` exists for async per-queue options (`name` goes outside the factory).

### Producer (API side)

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class VideoProcessingProducer {
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
}
```

### Consumer (worker side — TD-05 standalone context)

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> { /* ... */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* mark video failed when attempts exhausted */ }
}
```

The return value of `process()` is stored on the job. Only register the `@Processor` provider in the worker's module (TD-05), not in the API module, or the API process will also consume jobs.

### Testing

`getQueueToken('video-processing')` (`BullQueue_video-processing`) gives the DI token — use `moduleRef.get<Queue>(getQueueToken(name))` in integration/e2e specs, or `overrideProvider(getQueueToken(name))` in unit specs.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7) — High reputation. Maps to `phase-03-videos/TD-02` (B), `TD-03` (A), `TD-04` (A), `TD-12` (B).

### Client config for MinIO (TD-03 / TD-04)

```typescript
new S3Client({
  endpoint: cfg.endpoint,            // internal: http://minio:9000 | public: S3_PUBLIC_ENDPOINT
  region: cfg.region,
  forcePathStyle: cfg.forcePathStyle, // true for MinIO
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

`requestChecksumCalculation` / `responseChecksumValidation` accept `WHEN_REQUIRED` | `WHEN_SUPPORTED` (default `WHEN_SUPPORTED`, see aws-sdk-js-v3#6810). `WHEN_REQUIRED` is mandatory here — otherwise presigned `UploadPart` URLs embed CRC32 checksum params that the browser upload cannot satisfy on S3-compatible servers.

### Multipart commands used (TD-02)

`CreateMultipartUploadCommand` → (client PUTs parts via presigned `UploadPart`) → `ListPartsCommand` (resume + build the complete list server-side) → `CompleteMultipartUploadCommand({ MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` → `HeadObjectCommand` (`ContentLength` size check). `AbortMultipartUploadCommand` for cancel/cleanup (TD-11). `PutObjectCommand` for thumbnails.

- Each part must return an `ETag`; the SDK's own uploader throws "Missing Bucket CORS configuration for ETag header?" when absent — the bucket CORS must expose `ETag` (TD-04).
- `ListParts` is paginated (`IsTruncated`, `NextPartNumberMarker`, `MaxParts` default 1000) — loop until not truncated; 10 GiB / 16 MiB = 640 parts fits one page, but don't rely on it.

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` → `packages/s3-request-presigner` README. Maps to `phase-03-videos/TD-02` (B), `TD-04` (A), `TD-05` (A), `TD-08` (A).

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// TD-02 — browser part upload (signed with the PUBLIC client, TD-04)
const url = await getSignedUrl(publicClient,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 900 });

// TD-08 — stream/download redirect
const dl = await getSignedUrl(publicClient,
  new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="..."' }),
  { expiresIn: 300 });
```

- `expiresIn` is in seconds; default **900**.
- Presigning is offline (HMAC only) — the public client never opens a connection (TD-04). The worker presigns ffprobe/ffmpeg input URLs with the **internal** client (TD-05).
- `ResponseContentDisposition` / other `response-*` overrides only work on signed requests — fine for presigned GETs (TD-08 download).
- `Content-Type` is unsignable by default; to enforce it pass `signableHeaders: new Set(['content-type'])`. x-amz-* headers to enforce go in `unhoistableHeaders`.
- Payload is `UNSIGNED-PAYLOAD`: presigned PUTs **cannot** enforce part size/Content-Length — confirms TD-02's server-side `HeadObject.ContentLength` re-check at complete.
