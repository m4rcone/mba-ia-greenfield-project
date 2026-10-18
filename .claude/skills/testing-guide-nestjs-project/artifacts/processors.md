> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# Queue Processors & External-Binary Services

Covers two artifact types introduced in Phase 03 (video worker):

- **BullMQ processors** (`*.processor.ts`, `@Processor` + `WorkerHost`) and the worker services they dispatch to (e.g. `VideoProcessingService`, `UploadReconcilerService`)
- **Services that run external binaries** (`execFile` on ffprobe/ffmpeg, e.g. `MediaProbeService`, `ThumbnailService`)

Strategies for Redis, MinIO and the binaries themselves are in `../references/external-systems.md`.

---

## Layer matrix

| Artifact | Unit (`*.spec.ts`) | Integration (`*.integration-spec.ts`) |
|---|---|---|
| Processor (`@Processor`) | Dispatch by `job.name` (including the unknown name → `UnrecoverableError`); `@OnWorkerEvent('failed')` decision between final failure and intermediate attempt | Real Postgres + Redis + MinIO (+ ffmpeg): enqueue via the real producer, `module.init()`, and assert the final DB row and storage state |
| Worker service with branching (state machine, job-state branches) | Every branch, with repo / queue / storage / binary services mocked at the boundary | Real systems; backdate rows (`UPDATE … SET updated_at = now() - make_interval(…)`) to reach time thresholds |
| Service running a binary | Usually none: the logic *is* the binary call | Real binary on `test/fixtures/media/` fixtures, one test per failure class (valid, corrupt, not-a-video, unsupported, unreachable input) |
| `WorkerModule` | Compilation test (`Test.createTestingModule({ imports: [WorkerModule] }).compile()` with a test `BULLMQ_PREFIX`) | — |

E2E does not apply: the worker exposes no HTTP surface.

---

## What to test

- **Idempotency** (at-least-once delivery): re-running the same job leaves the same outputs (one deterministic object, an unchanged `ready` row).
- **Conditional transitions**: a row that is not in the expected `processing_status` is never overwritten. Seed it in another status and assert it is unchanged.
- **Error classification**: permanent errors become `UnrecoverableError` (one attempt) and transient errors propagate (all `attempts`). Assert `attemptsMade` and the persisted `processing_error`.
- **Cleanup side effects** on failure (objects removed or kept), asserted through the raw S3 client.
- **Scheduled jobs**: `upsertJobScheduler` registration is idempotent (call the bootstrap hook twice → `getJobSchedulers()` has length 1), and a second run of the job has no further effect.
- **Binary services**: stderr / exit-code classification into typed errors versus retryable plain `Error`s.

## What NOT to test

- BullMQ's own retry/backoff timing: trust the library and use a short `backoff` override.
- ffmpeg output quality: assert only format (JPEG SOI `FF D8` and EOI `FF D9` markers) and that the call succeeded.
- `execFile` argument building through mocks; the real-binary integration test covers it.

---

## Example: processor unit test

```typescript
const videoProcessingService = { process: jest.fn(), markFailed: jest.fn() };

beforeEach(async () => {
  jest.resetAllMocks();
  const module = await Test.createTestingModule({
    providers: [
      VideoProcessor,
      { provide: VideoProcessingService, useValue: videoProcessingService },
      { provide: UploadReconcilerService, useValue: { run: jest.fn() } },
    ],
  }).compile();
  processor = module.get(VideoProcessor);
});

it('should not mark the video failed after an intermediate attempt', async () => {
  await processor.onFailed(job({ attemptsMade: 2 }), new Error('timeout'));
  expect(videoProcessingService.markFailed).not.toHaveBeenCalled();
});
```

Reference specs: `src/worker/processors/*.spec.ts`, `src/worker/reconciler/*.spec.ts`, `src/worker/media/*.integration-spec.ts`.
