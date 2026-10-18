# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 14/14 completed

### SI-03.1 — Infra: dependências e serviços Compose (MinIO, Redis, buckets)
- **Status:** completed
- **Tests:** no tests (Infra); existing suite still green (144 unit/integration, 52 e2e)
- **Observations:**
  - **MinIO image:** official `minio/minio` / `minio/mc` images are no longer published (Docker Hub and Quay). With the user's approval, used the drop-in community fork `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` + `pgsty/mc:RELEASE.2026-10-18T00-00-00Z`. TD-13 should record this.
  - **CORS:** MinIO does not support bucket-level CORS (`PutBucketCors` is unimplemented; per MinIO docs). It is configured globally on the `minio` service via `MINIO_API_CORS_ALLOW_ORIGIN`, not in `minio-init` as the technical action describes. Verified: preflight allows GET/PUT/HEAD, `Etag` is exposed, other origins are rejected.
  - **Frontend origin:** assumed `http://localhost:3001` because `next-frontend` does not exist yet and the API uses port 3000. Revisit when the frontend is initialized.
  - **Stale-upload backstop:** `MINIO_API_STALE_UPLOADS_EXPIRY=48h`, longer than the reconciler threshold so the app acts first. Align it with the `UPLOAD_ABANDON_AFTER_HOURS` default in SI-03.2.
  - **Redis:** runs with AOF persistence (`--appendonly yes`) per TD-01 cons, and `noeviction` is confirmed.
  - **Out of scope:** `test:e2e` script lacks `--runInBand` even though `nestjs-project/CLAUDE.md` says it is configured; the e2e suites currently run in parallel workers.

### SI-03.2 — Infra: namespaces de configuração storage, redis e upload
- **Status:** completed
- **Tests:** 12 passing (`env.validation.integration-spec.ts`); tsc clean
- **Observations:**
  - Defaults the plan did not specify were picked here: `S3_REGION=us-east-1`, `S3_FORCE_PATH_STYLE=true`, `PRESIGNED_GET_TTL_SECONDS=14400` (4h, for long videos), `UPLOAD_ABANDON_AFTER_HOURS=24` (below the 48h MinIO stale-upload backstop from SI-03.1), `PROCESSING_STUCK_AFTER_MINUTES=60`.
  - Joi also enforces `UPLOAD_PART_SIZE_BYTES >= 5 MiB`, the S3 minimum part size.
  - `nestjs-api` had no `environment` block in `compose.yaml`, so one was added with only the Compose-specific hosts (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `REDIS_HOST`, `REDIS_PORT`). Credentials stay in `.env` / `.env.example`, and the local `.env` was updated the same way. The container must be recreated (`docker compose up -d nestjs-api`) for the block to take effect.
  - AC "app boots / `GET /` 200" was not checked against a running server, because the dev server is only started on explicit request. The missing-`S3_ACCESS_KEY` rejection is covered by the Joi schema test.

### SI-03.3 — StorageModule com clientes S3 interno e público
- **Status:** completed
- **Tests:** 13 passing (`storage.module.spec.ts`, `storage.service.integration-spec.ts`); tsc clean; eslint clean on touched files
- **Observations:**
  - SigV4 signs the `Host` header, so presigned URLs cannot be rewritten after signing. The integration tests that actually `fetch` presigned URLs therefore load a test `storage` namespace with `publicEndpoint = S3_ENDPOINT` (reachable from the container). The "host = `S3_PUBLIC_ENDPOINT`, no CRC32 params" AC is asserted separately with the default config, using offline signing only.
  - Client tokens (`S3_INTERNAL_CLIENT`, `S3_PUBLIC_CLIENT`) and the part-URL TTL default (`PRESIGNED_PART_URL_TTL_SECONDS = 900`, the SDK default) live in `src/storage/storage.constants.ts`. The plan does not name a config key for the part-URL TTL. Presigned GETs default to `PRESIGNED_GET_TTL_SECONDS`.
  - `listParts` pagination is tested against real MinIO by adding an SDK `initialize` middleware that forces `MaxParts=1`. A `jest.spyOn(send)` approach broke `no-misused-promises` and `unbound-method`.
  - `src/test/minio.ts` creates a uniquely named test bucket per suite, then empties it (aborting any open multipart uploads first) and deletes it. Dev buckets are never touched.
  - `StorageModule` is not imported into `AppModule` yet. Its consumers (`VideosModule`, worker) wire it in SI-03.7 and SI-03.10.

### SI-03.4 — Entidade Video e migration CreateVideos
- **Status:** completed
- **Tests:** 8 passing (`video.entity.integration-spec.ts`, `migrations.integration-spec.ts`); tsc clean; `migration:revert` + `migration:run` verified via CLI against the dev DB
- **Observations:**
  - `size_bytes` (bigint) and `duration_seconds` (numeric) use a transformer that turns pg's string values into JS numbers. This is safe because values are at most 10 GiB and durations have 3 decimals. The entity exposes `number`, not `string`.
  - Enum types are named exactly `video_status` / `video_processing_status` (via `enumName`). The migration spec now also drops those enums in its setup, because DROP TABLE does not remove them.
  - Timestamps are `timestamptz`, per the Data Model. Earlier tables use `timestamp`, so the two differ.
  - Following the plan, there is only a `@ManyToOne` on `Video`. No inverse `@OneToMany` was added to `Channel`, even though `.claude/rules/nestjs-entities.md` asks for both sides. Add it in a later phase if `channel.videos` is needed.
  - `VideosModule` exports `TypeOrmModule` (the same pattern as `ChannelsModule`) and is registered in `AppModule`.
  - **Follow-up, resolved before SI-03.5:** fixed the lint errors in Phase 03 files. In `create-test-data-source.ts`, the `Function` type was replaced by `DataSourceOptions['entities']`. In `env.validation.integration-spec.ts`, the `validate` helper now has a typed return. Ran Prettier on `upload.config.ts`. Also added `--runInBand` to `test:e2e`, which closes the SI-03.1 observation.
  - **Follow-up, regression fixed:** the migrations spec ran `DROP TABLE … CASCADE` in parallel with `Promise.all`. Once `videos` (which has an FK to `channels`) was added, this deadlocked intermittently and left the shared DB half-dropped. The drops now run one at a time, and the dev DB was reset and re-migrated. Full suite green: 171 unit/integration tests (run twice, stable) and 52 e2e.
  - **Out of scope, separate task:** `npm run lint` still reports 141 errors in Phase 02 files (`auth.service.spec.ts`, `test/auth.e2e-spec.ts`, `mail.service.integration-spec.ts`, `channels.service.spec.ts`, `channels.service.ts`, `domain-exception.filter.spec.ts`, and others). The user chose to fix them on a separate `bugfix/lint-phase-02` branch from `dev`, merged before the phase's final verification.

### SI-03.5 — Allowlist de formatos e gerador de public ID
- **Status:** completed
- **Tests:** 41 passing (`video-formats.spec.ts`, `public-id.util.spec.ts`); tsc clean; eslint clean on `src/videos`
- **Observations:**
  - `validateProbe(probe)` has no `contentType` input, and ffprobe reports the same `format_name` (`mov,mp4,m4a,3gp,3g2,mj2`) for `.mp4` and `.mov`. So the allowed codecs are the union of every allowlist row sharing that container. In practice, a `.mov` with `av1` video or `mp3` audio passes the probe check. If SI-03.11/12 need the stricter per-extension rule, they can pass the declared `content_type` to narrow it.
  - Check order in `validateProbe`: `NOT_A_VIDEO` → `UNSUPPORTED_CONTAINER` → `UNSUPPORTED_CODEC` → `CORRUPT_MEDIA` (structural). Codec names are compared in lowercase. The audio codec is taken from the first audio stream, and `null` means no audio.
  - `isDeclaredFormatAllowed` compares `contentType` case-insensitively. Extension matching uses `path.extname`, so only the last extension counts (`archive.tar.webm` → `video/webm`).
  - `generatePublicId` uses rejection sampling: bytes ≥ 248 are discarded, then the rest are mapped `% 62`. The uniqueness test checks 100k IDs.

### SI-03.6 — QueueModule e VideoProcessingProducer
- **Status:** completed
- **Tests:** 16 passing (`queue.module.spec.ts`, `video-processing.producer.integration-spec.ts`, `env.validation.integration-spec.ts`); tsc clean; eslint clean on touched files; no open handles
- **Observations:**
  - **TD-01 deviation (user-approved):** `@nestjs/bullmq` is pinned to `^11.0.5` instead of `^12.x`. Version 12.0.0 ships ESM-only (`"type": "module"`) and targets Nest 12, so the CommonJS Jest/ts-jest setup cannot load it. 11.0.5 is CommonJS and declares `bullmq ^6` + `@nestjs/core ^11`. Upgrade it together with a future Nest 12 migration. TD-01 / `library-refs.md` should record this.
  - **New dependency:** BullMQ 6 made `ioredis` an optional peer (`>=5`), so it is not installed automatically. Added `ioredis@^5.11.1` as a direct dependency.
  - **New config key:** added `BULLMQ_PREFIX` (default `bull`) to the env schema, `.env.example` and `redisConfig.queuePrefix`. This is the "parametrizable prefix" the SI asks for; the plan named no key. Tests override the `redis` namespace with a unique prefix per suite through `testRedisConfig()` in `src/test/redis.ts` (the same `registerAs` override pattern SI-03.3 used for storage).
  - Retention is `removeOnComplete.age = 24h` and `removeOnFail.age = 7d`, both longer than `PROCESSING_STUCK_AFTER_MINUTES` (60), so `jobId` dedup stays effective for the reconciler. These values live in `PROCESS_VIDEO_JOB_OPTIONS` in `queue.constants.ts`.
  - `src/test/redis.ts` also provides `createTestQueue(prefix)` for the worker specs (SI-03.10+). This SI does not use it.
  - `QueueModule` is not imported into `AppModule` yet. `VideosModule` will wire it in SI-03.7.

### SI-03.7 — VideosService: pré-cadastro e ciclo de vida do upload multipart
- **Status:** completed
- **Tests:** 33 passing (`videos.service.spec.ts`, `videos.service.integration-spec.ts`, `channels.service.integration-spec.ts`); e2e still green (52); tsc clean; eslint clean on new files
- **Observations:**
  - The service returns domain objects (`Video`, `PresignedParts`, `UploadProgress`). Mapping them to the HTTP response shape (`partSize`/`partCount` camelCase, 202 body) is left to the controller in SI-03.8.
  - `ChannelsModule` already exported `ChannelsService`, so only `findByUserId` was added. If a user has no channel, `initiateUpload` throws a plain `Error` (a 500). Every registered user gets a channel in Phase 02, so the plan defines no domain code for this.
  - `findOwnedOrFail` uses a TypeORM nested relation `where` (`channel: { user_id }`), which generates the `videos → channels` join.
  - Every `uploading → *` transition is a conditional `UPDATE … WHERE processing_status='uploading'` that also clears `upload_id`. If a concurrent request already moved the row (affected = 0), it throws `UPLOAD_NOT_IN_PROGRESS`, and `completeUpload` does not enqueue.
  - `headObject` returning `null` (object missing after complete) is treated as a size mismatch.
  - If the abort after a definitive INSERT failure itself fails, that error is logged and the original INSERT error is still propagated.
  - New shared helper `src/common/database/pg-errors.ts` (`isUniqueViolationOnColumn`, typed via `driverError`). `ChannelsService` keeps its own private copy, which has 6 pre-existing lint errors. Switching it to the shared helper fits the `bugfix/lint-phase-02` task.
  - Storage key and processing-error constants live in `src/videos/videos.constants.ts` (`originalObjectKey`, `VIDEO_PROCESSING_ERRORS`) so the worker and reconciler can reuse them.
  - The integration spec signs presigned part URLs with the internal endpoint (the same SigV4 Host constraint as SI-03.3) and uploads real parts to a per-suite MinIO bucket and Redis prefix.

### SI-03.8 — Endpoints de upload multipart (initiate, parts, complete, cancel)
- **Status:** completed
- **Tests:** 9 passing (`videos.module.spec.ts` 1, spec-derived `test/videos-upload.e2e-spec.ts` 8); tsc clean; eslint clean on new files; no open handles
- **Observations:**
  - **`@SkipThrottle()` on `VideosController`:** this was not in the plan. Phase 02's `ThrottlerGuard` is global (10 req/min), and only auth endpoints are meant to be limited, since `AppController` already opts out. A 10 GiB upload needs about 7 presign calls plus list and complete, so throttling `/videos` would break real uploads.
  - The `fileSize` upper bound uses a custom `@MaxUploadSize()` validator that reads `uploadConfig().maxSizeBytes` at validation time. There is no `env_file` in Compose, so `.env` only reaches `process.env` when ConfigModule boots, after the DTO module is imported. A static `@Max(...)` would freeze the default value.
  - `contentType` is only `@IsString()` in the DTO. Allowlist and agreement violations are the service's `UNSUPPORTED_VIDEO_FORMAT`, per Validation Rules.
  - Request and response DTOs carry explicit `@ApiProperty`. `openapi:export` runs through ts-node, so the `@nestjs/swagger` CLI plugin never runs there. **Pre-existing, out of scope:** the committed `openapi.json` has empty `properties` for every Phase 02 DTO (e.g. `RegisterDto`). The export should use the plugin, or those DTOs should get explicit decorators.
  - `401` is declared once at class level (`@ApiErrorResponse(401)`), and `openapi.json` shows it on all five operations. Regenerating `openapi.json` only added lines (582 insertions); existing operations are unchanged.
  - The E2E points `BULLMQ_PREFIX`, `S3_BUCKET_VIDEOS` (a per-suite bucket it creates and deletes) and `S3_PUBLIC_ENDPOINT=http://minio:9000` (as the spec says) at test values before `AppModule` boots, and restores them afterwards, so the dev queue and buckets are never touched. Confirmation tokens are read from Mailpit via the `/api/v1/search?query=to:` API.
  - AC "API memory stays stable during a large upload" is met by design: there is no multipart/raw body parser and the JSON body limit is unchanged, so video bytes only go client → MinIO. The test spec has no automated scenario for it.
  - **Note for final verification:** `test:e2e` now includes this suite, so it needs minio, redis and mailpit up (not only db).

### SI-03.9 — Endpoints de consulta, streaming e download
- **Status:** completed
- **Tests:** 40 passing in `videos.service.spec.ts` + `videos.service.integration-spec.ts` (includes the SI-03.7 cases); spec-derived `test/videos-playback.e2e-spec.ts` 7 passing, and the refactored `videos-upload.e2e-spec.ts` still 8 passing; tsc clean; eslint clean on touched files; no open handles
- **Observations:**
  - `/stream` and `/download` use `@Res()` + `res.setHeader('Cache-Control', 'no-store')` + `res.redirect(302, url)` rather than `@Redirect`/`@Header`, so the header is guaranteed on the redirect response. Errors still go through the domain exception filter, because the service throws before `res` is touched.
  - The download disposition is `attachment; filename*=UTF-8''<RFC 5987 encoding>`: `encodeURIComponent` plus `'()*` escaped, exactly as TD-08 specifies. There is no ASCII `filename=` fallback, since the plan specifies only `filename*`.
  - `PUBLIC_ID_PATTERN` is exported from `public-id.util.ts` and checked before any DB query. A malformed id returns `VIDEO_NOT_FOUND` without a query.
  - `getOwnedVideo` returns `VideoResponseDto` directly, as the plan names it. `thumbnail_url` stays `null` unless the video is `ready` and has a `thumbnail_key`.
  - **Test helper refactor:** the signup → Mailpit token → confirm → login helper moved from `videos-upload.e2e-spec.ts` to `test/utils/e2e-auth.ts`, which both video e2e suites now use. `auth.e2e-spec.ts` keeps its own spy-based helper, which is part of the Phase 02 lint debt.
  - The playback E2E creates a separate thumbnails test bucket with an anonymous-read `PutBucketPolicy`, mirroring `mc anonymous set download`. It never touches the dev buckets.
  - `openapi.json` regenerated: `/videos/{id}` (200, 400, 401, 404), `/stream` and `/download` (302, 401, 404, 409). The export only added lines.

### SI-03.10 — Infra: runtime do Video Worker (entrypoint, módulo e container com FFmpeg)
- **Status:** completed
- **Tests:** 1 passing (`worker.module.spec.ts`); e2e still green (60 across 4 suites); tsc clean; eslint clean on touched files. Infra ACs checked by hand: the worker has no published ports and stays up; `ffmpeg`/`ffprobe` 5.1.9 run in both containers; `docker compose stop video-worker` runs the shutdown hook (`Video worker stopped (SIGTERM)` log); `npm run build` emits `dist/main.js` and `dist/worker/main.js`
- **Observations:**
  - **Shared bootstrap options:** `configModuleOptions` (`src/config/config-module.options.ts`) and `typeOrmConnectionOptions()` (`src/database/typeorm-connection.options.ts`) are now used by both `AppModule` and `WorkerModule`, so the 8 config factories and the Joi schema are not duplicated. `AppModule` keeps `autoLoadEntities`. `WorkerModule` lists `[Video, Channel, User]` explicitly, because the Video → Channel → User relations require all three entities' metadata.
  - **`video-worker` command:** it runs `nest build --path tsconfig.worker.json && exec node dist-worker/worker/main` under `init: true` (tini), instead of `npm run start:worker:dev`. Two reasons: npm turns SIGTERM into `exit 1`, and `nest start --watch` kills its child without running shutdown hooks, which was verified. The cost is no hot reload in the container, so restart the service after worker code changes. `start:worker:dev` (watch mode) is still in `package.json` for interactive use. The exit code on stop is 143 because Nest re-raises the signal after its shutdown hooks run; that is the normal graceful path.
  - **Separate worker build output:** the worker builds to `dist-worker/` (`tsconfig.worker.json`), so its build never wipes the API's `dist/` (`deleteOutDir`). `dist-worker` is added to `.gitignore` and to the `exclude` of `tsconfig.json` and `tsconfig.build.json`. The build config's own `exclude` overrides the base one, and without it the worker compiled its own output.
  - The worker gets env the same way `nestjs-api` does (ConfigModule reads the shared `.env` from the mounted volume), so the service has no `environment` block. The `nestjs-api` service in `compose.yaml` has no `environment` block either, despite the SI-03.2 note; config comes entirely from `.env`.
  - The dev image was rebuilt, which recreated the `nestjs-api` container (ffmpeg via apt). `WorkerModule` logs on shutdown (`OnApplicationShutdown`).
  - `WorkerModule` has no `@Processor` yet. `VideoProcessor` arrives in SI-03.12.

### SI-03.11 — Serviços de mídia do worker: probe (ffprobe) e thumbnail (ffmpeg)
- **Status:** completed
- **Tests:** 50 passing across `media-probe.service.integration-spec.ts`, `thumbnail.service.integration-spec.ts`, `video-formats.spec.ts` and `worker.module.spec.ts`; tsc clean; eslint clean; no open handles
- **Observations:**
  - **`validateProbe` changed (an SI-03.5 artifact):** ffprobe reads a PNG renamed to `.mp4` as `format_name: png_pipe` with a real `codec_type: video` stream and no `attached_pic` flag. Under the SI-03.5 rules it would have been rejected as `UNSUPPORTED_CONTAINER`, which violates this SI's AC (`NOT_A_VIDEO` or `CORRUPT_MEDIA`). Still-image demuxers (`image2`, `*_pipe`) now contribute no video streams, so the file becomes `NOT_A_VIDEO`. A unit case was added to `video-formats.spec.ts`.
  - **Fixtures:** generated in the container with ffmpeg lavfi test sources (`testsrc` + `sine`); about 120 KB in total in `test/fixtures/media/`. `truncated.mp4` is the first 20 KB of the valid mp4, whose moov atom sits at the end, so ffprobe reports `moov atom not found`. The out-of-allowlist file is a matroska with `mpeg4` video, which gives `UNSUPPORTED_CODEC`. The fixture list and upload helper live in `src/test/media-fixtures.ts`.
  - **Error classification:** only ffprobe stderr matching `Invalid data found when processing input` or `moov atom not found` becomes `MediaValidationError('CORRUPT_MEDIA')`. Everything else (HTTP 404, network errors, timeouts) is rethrown as a plain `Error` with `cause`, so BullMQ can retry it. The unreachable-URL test presigns a missing key, which storage answers with 404.
  - ffprobe and ffmpeg run via `execFile` with no shell, with timeouts of 60 s and 120 s and bounded `maxBuffer`; values are in `media.constants.ts`. The thumbnail uses input seeking (`-ss` before `-i`) at `min(1, duration * 0.1)` and pipes a single mjpeg frame to stdout. An empty output throws a transient error.
  - Both services are registered as providers in `WorkerModule`.

### SI-03.12 — VideoProcessor: processamento automático e geração de thumbnail
- **Status:** completed
- **Tests:** 22 passing (`video-processing.service.spec.ts` 10, `video.processor.spec.ts` 6, `video.processor.integration-spec.ts` 5, `worker.module.spec.ts` 1); tsc clean; eslint clean on `src/worker`, `src/test`, `videos.constants.ts`; no open handles
- **Observations:**
  - An earlier session wrote the code and tests. This session reviewed them against the SI and ran them, and changed nothing.
  - The skip guard is wider than "already `ready` → no-op": `process` skips any row that is not `processing`, including a missing row. This covers both the idempotency AC and the "never overwrite a non-`processing` video" AC.
  - `MediaUnrecoverableError` (in `media-unrecoverable.error.ts`) extends BullMQ's `UnrecoverableError` and carries the typed `ProbeError` code. `markFailed` uses it to tell a media failure (persist the code and delete the original and thumbnail prefix) from a transient one (`PROCESSING_FAILED`, objects kept).
  - An unknown `job.name` throws `UnrecoverableError`, and `onFailed` ignores job names other than `process-video`. SI-03.13 adds the `cleanup-stale-uploads` branch to the same switch.
  - **Dev runtime:** the `video-worker` container has no hot reload (see SI-03.10). Restart it (`docker compose restart video-worker`) so the running worker picks up `VideoProcessor`.

### SI-03.13 — Reconciliador de uploads abandonados e vídeos travados
- **Status:** completed
- **Tests:** 29 passing across `upload-reconciler.service.spec.ts`, `upload-reconciler.service.integration-spec.ts`, `video.processor.spec.ts` (gained the `cleanup-stale-uploads` dispatch case), `video.processor.integration-spec.ts` and `worker.module.spec.ts`; tsc clean; eslint clean on `src/worker`; no open handles
- **Observations:**
  - **Scheduler as its own provider:** `ReconcilerScheduler` (`src/worker/reconciler/reconciler.scheduler.ts`) runs `upsertJobScheduler` in `onApplicationBootstrap`, which keeps scheduling separate from the reconcile logic. The cron is `0 0 * * * *` (hourly, 6-field). The job template keeps `removeOnComplete: { count: 24 }` and `removeOnFail: { count: 100 }`, because no jobId dedup depends on its history. Values are in `reconciler.constants.ts`.
  - **Per-row isolation:** each row is reconciled inside a try/catch that logs and moves on (`forEachIsolated`). This is the background-job exception in `.claude/rules/nestjs-services.md`. Without it, one poison row (for example a non-`NoSuchUpload` abort failure) would fail every hourly run and block steps 2 and 3. The row is retried on the next run.
  - **`NoSuchUpload` on abort is ignored**, because the MinIO stale-upload backstop may already have removed the multipart. The row is still marked `UPLOAD_ABANDONED`. This is handled in the reconciler; `StorageService.abortMultipartUpload` (SI-03.3) is unchanged.
  - The step 2 branches follow the plan: `failed` → conditional `PROCESSING_FAILED`; job absent, `completed` or `unknown` → `job.remove()` (if it exists), then `enqueueProcessVideo`; any other state (`active`/`waiting`/`delayed`/`prioritized`/`waiting-children`) → left alone. Re-enqueuing does not bump `updated_at`. While the new job is `waiting`, the next run leaves the row alone, so the second run does nothing.
  - `run()` returns a `ReconcileSummary` (counts per step). The integration spec uses it to check the "second run does nothing" AC. The processor does not store it on the job.
  - Added `UPLOAD_ABANDONED` to `VIDEO_PROCESSING_ERRORS`.
  - The integration spec compiles `WorkerModule` without `init()`, so no BullMQ worker takes the jobs under test. A throwaway `Worker` throwing `UnrecoverableError` produces a real `failed` job. The `active` state is covered only in the unit spec.
  - **Out of scope, scaling:** step 3 HEADs the original of **every** `failed` row on every run, so the cost grows with the total number of failed videos. A follow-up could limit it to recent rows, or record that the original was deleted.
  - **Dev runtime:** restart `video-worker` to register the scheduler and load the new dispatch branch.

### SI-03.14 — Atualizar o testing guide para storage, fila e FFmpeg
- **Status:** completed
- **Tests:** no tests (documentation-only SI)
- **Observations:**
  - `references/external-systems.md`: replaced the "Object Storage — Local Filesystem" and "Message Queue — TBD" sections with real MinIO / real BullMQ on Redis. They cover per-suite buckets (`src/test/minio.ts`) and BullMQ prefixes (`src/test/redis.ts`), `obliterate` in `beforeEach` and `afterAll`, consumer specs with and without `module.init()`, and the short-backoff retry pattern. Added an "External Binaries — Real ffprobe / ffmpeg" section pointing to `test/fixtures/media/` and `MEDIA_FIXTURES`.
  - **New file `artifacts/processors.md`** (not named in the plan): a layer matrix and what-to-test list for BullMQ processors, worker services and binary-running services. `SKILL.md` §3 checklist and §4 table link to it. The "Queue Consumers / Processors" section in `artifacts/future-types.md` became a pointer to the new file.
  - `references/gotchas.md`: added §12 (`requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'`), §13 (SigV4 host binding → `S3_PUBLIC_ENDPOINT=http://minio:9000` in tests) and §14 (close `Queue`/`Worker`; `obliterate` before `module.close()`).
  - Every helper, file path and pattern cited was checked against the current specs.
