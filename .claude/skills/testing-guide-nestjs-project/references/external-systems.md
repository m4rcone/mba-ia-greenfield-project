> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real MinIO (Docker)

**Strategy:** Real S3-compatible storage via the Docker `minio` service in `compose.yaml` (TD-13). No local-filesystem adapter and no SDK mocks. The same `@aws-sdk/client-s3` code path runs in tests and in production.

**Isolation: one throwaway bucket per suite.** Never touch the dev buckets (`videos`, `thumbnails`). The helpers in `src/test/minio.ts` do this:

| Helper | Purpose |
|---|---|
| `createMinioTestClient()` | Raw `S3Client` pointed at `S3_ENDPOINT`, used to seed and assert objects directly |
| `testBucketName(purpose)` | Unique name per suite run (`test-<purpose>-<ts>-<rand>`) |
| `createTestBucket(client, bucket)` | Idempotent create |
| `emptyTestBucket(client, bucket)` | Aborts open multipart uploads, then deletes every object |
| `deleteTestBucket(client, bucket)` | Empties, then deletes the bucket (call in `afterAll`) |

Point the code under test at the test buckets with one of two methods:
- **Module/integration specs:** override the `storage` namespace with `registerAs('storage', () => ({ ...storageConfig(), buckets: {...} }))` (see `src/storage/storage.service.integration-spec.ts`).
- **E2E / whole-module specs (`AppModule`, `WorkerModule`):** set `S3_BUCKET_VIDEOS` / `S3_BUCKET_THUMBNAILS` in `process.env` **before** compiling the module, and restore them in `afterAll`.

**Setup pattern:**
```typescript
const videosBucket = testBucketName('worker-videos');
let s3: S3Client;

beforeAll(async () => {
  process.env.S3_BUCKET_VIDEOS = videosBucket; // before Test.createTestingModule
  s3 = createMinioTestClient();
  await createTestBucket(s3, videosBucket);
  // ... compile module
});

afterAll(async () => {
  await module.close();
  await deleteTestBucket(s3, videosBucket);
  s3.destroy();
  // restore process.env
});
```

**Assert storage side effects directly** with `HeadObjectCommand` / `ListObjectsV2Command` / `ListMultipartUploadsCommand` on the raw client. Do not assert them through the service under test.

**Presigned URLs:** tests that `fetch` a presigned URL must sign it against an endpoint the container can reach (`http://minio:9000`), because SigV4 signs the `Host` header. See `gotchas.md` §13.

---

## Message Queue — Real BullMQ on Redis (Docker)

**Strategy:** Real BullMQ over the Docker `redis` service (`maxmemory-policy noeviction`) (TD-01, TD-13). Never mock `Queue` in integration/E2E specs. `jobId` dedup, retries, backoff and `UnrecoverableError` only behave correctly against a real Redis.

**Isolation: unique BullMQ prefix per suite.** The helpers in `src/test/redis.ts` do this:

| Helper | Purpose |
|---|---|
| `testQueuePrefix()` | Unique prefix per suite run, so suites never share keys with the dev queue or each other |
| `testRedisConfig(prefix)` | `redis` namespace override (`registerAs`) for module/integration specs |
| `createTestQueue(prefix)` | Standalone `Queue` for asserting on jobs outside DI |
| `obliterateTestQueue(queue)` | `queue.obliterate({ force: true })`: wipes jobs **and** job schedulers |

For whole-module specs, set `process.env.BULLMQ_PREFIX = testQueuePrefix()` before compiling, the same way as the bucket env vars above.

**Rules:**
- `obliterateTestQueue` in `beforeEach` (isolation between tests) **and** `afterAll` (no leftover keys).
- Get the DI queue with `module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE))`.
- **Producer specs:** assert with `queue.getJob(videoId)` (`name`, `data`, `opts`) and `getState()`. Asserting on the jobId is stronger than counting jobs.
- **Consumer specs:**
  - *End-to-end processing:* `await module.init()` starts the `@Processor`'s worker. Enqueue through the real producer, then poll the DB row / job state until it settles (a bounded `waitFor` loop, see `src/worker/processors/video.processor.integration-spec.ts`).
  - *Driving a service in isolation:* compile without `init()` so no worker consumes the jobs under test (see `src/worker/reconciler/upload-reconciler.service.integration-spec.ts`). To reach a real `failed` job state, run a throwaway `new Worker(...)` with the same prefix that rejects with `UnrecoverableError`, then `close()` it.
- **Retry tests:** `queue.add` the job directly with `...PROCESS_VIDEO_JOB_OPTIONS`, overriding only `backoff` (`{ type: 'fixed', delay: 50 }`), so the real `attempts` stay but the test stays fast. Never fake BullMQ's clock. Simulate the transient error with `jest.spyOn` on the collaborator (e.g. `MediaProbeService.probeAndValidate`).
- Close everything: `module.close()` closes DI queues and workers, and standalone `Queue`/`Worker` instances need their own `close()` (see `gotchas.md` §14).

---

## External Binaries — Real ffprobe / ffmpeg

**Strategy:** Real binaries, installed in the dev image (`Dockerfile.dev`), run on small committed fixtures (TD-05, TD-13). Mocking `execFile` would hide argument, parsing and stderr-classification bugs.

- Fixtures live in `test/fixtures/media/` (about 120 KB in total, generated with ffmpeg lavfi test sources). The names are in `MEDIA_FIXTURES` (`src/test/media-fixtures.ts`): valid mp4/webm, sub-second clip, truncated mp4, PNG renamed to `.mp4`, codec outside the allowlist.
- `uploadMediaFixture(client, bucket, fileName)` puts a fixture into the test bucket, and the spec probes it via a presigned internal GET URL. This is the same input path the worker uses in production.
- Add a new fixture only when a new failure class needs it. Generate it with ffmpeg inside the container and document it in `MEDIA_FIXTURES`.

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
