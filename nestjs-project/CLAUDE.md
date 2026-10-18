# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (`db`, `mailpit`, `redis`, `minio`, plus the one-shot `minio-init`) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

The `nestjs-api` container idles (`CMD tail -f /dev/null` in `Dockerfile.dev`), so `docker compose up -d` does not boot the API. The `video-worker` container is different: its command builds and runs the worker, so `docker compose up -d` (without a service list) starts the worker process.

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # long-running services "running"; minio-init "exited (0)"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `curl -fs http://localhost:9000/minio/health/ready` (host) — expect exit code 0. `minio-init` must have exited 0: it creates the `videos` (private) and `thumbnails` (anonymous read) buckets.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services (`compose.yaml`):
- `nestjs-api` — NestJS API, port `3000` (container idles until `start:dev` is run)
- `video-worker` — video worker: same image and codebase, no HTTP port. Its command compiles `tsconfig.worker.json` to `dist-worker/` and runs `node dist-worker/worker/main` under `init: true`. There is no hot reload: after changing worker code, run `docker compose restart video-worker`.
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture: SMTP `1025`, web UI/API `8025`
- `redis` — Redis 8 for BullMQ, port `6379`, AOF persistence and `maxmemory-policy noeviction`
- `minio` — S3-compatible storage (`pgsty/minio`, a fork, because the official image is no longer published): API `9000`, console `9001`, credentials `streamtube` / `streamtube-secret`. CORS is set server-wide (`MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3001`, the frontend), and `MINIO_API_STALE_UPLOADS_EXPIRY=48h` is the backstop for abandoned multipart uploads.
- `minio-init` — one-shot `mc` job that creates the `videos` (private) and `thumbnails` buckets; `nestjs-api` and `video-worker` wait for it to finish. Anonymous access to `thumbnails` is `s3:GetObject` only, from `minio/thumbnails-anonymous-policy.json` (also loaded by `test/videos-playback.e2e-spec.ts`). Do not switch it to `mc anonymous set download`: that also grants `s3:ListBucket`, which lists every thumbnail key and so every video UUID.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Verify Redis and MinIO are ready
docker compose exec redis redis-cli ping
curl -fs http://localhost:9000/minio/health/ready

# Check container logs
docker compose logs nestjs-api
docker compose logs video-worker
docker compose logs db

# Reload the worker after code changes (no hot reload)
docker compose restart video-worker

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # API dev server with hot-reload
npm run start:worker:dev                 # Worker in watch mode (interactive use; video-worker container already runs it)
npm run build                            # Compile to dist/ — emits dist/main.js (API) and dist/worker/main.js (worker)
npm run start:prod                       # Run compiled API
npm run start:worker                     # Run compiled worker (node dist/worker/main)

npm test                                 # Unit + integration tests (*.spec.ts and *.integration-spec.ts)
npm run test:integration                 # Integration tests only (already --runInBand)
npm run test:watch                       # Tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (already --runInBand)

npm run migration:run                    # Apply pending migrations (src/database/data-source.ts)
npm run migration:revert                 # Revert the last migration
npm run migration:generate               # Generate a migration from entity changes
npm run openapi:export                   # Regenerate openapi.json

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs video-worker
docker compose restart video-worker
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl -fs http://localhost:9000/minio/health/ready
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

Suites also use the real external services, not mocks: MinIO (a throwaway bucket per suite, `src/test/minio.ts`), Redis/BullMQ (a unique queue prefix per suite, `src/test/redis.ts`), Mailpit, and ffprobe/ffmpeg on the fixtures in `test/fixtures/media/`. `npm test` and `npm run test:e2e` therefore need `db`, `redis`, `minio` and `mailpit` up. See the `testing-guide-nestjs-project` skill for the isolation patterns.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker`, `start:worker:dev`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.
- `maxWorkers: 1` (`package.json`) and `--runInBand` (the `test:integration` and `test:e2e` scripts) — the suites share one database.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Build Outputs

- `npm run build` (`tsconfig.build.json`) → `dist/`, including the worker entrypoint `dist/worker/main.js`.
- The `video-worker` container builds with `tsconfig.worker.json` into `dist-worker/`, so its build never wipes the API's `dist/` (`deleteOutDir`). `dist-worker/` is git-ignored and excluded from `tsconfig.json` / `tsconfig.build.json`.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`. Two entrypoints share the codebase:

- `src/main.ts` → `AppModule`: the HTTP API. Swagger is served at `/api/docs` when `SWAGGER_ENABLED=true`.
- `src/worker/main.ts` → `WorkerModule`: a standalone application context (`createApplicationContext`, no HTTP server) with shutdown hooks, so SIGTERM lets the current job finish.

Both import `configModuleOptions` (`src/config/config-module.options.ts`, the config namespaces plus the Joi schema) and `typeOrmConnectionOptions()` (`src/database/typeorm-connection.options.ts`).

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

Modules: `auth`, `users`, `channels`, `mail`, `videos`, plus two infrastructure modules shared by the API and the worker:

- `StorageModule` (`src/storage/`) — `StorageService` over `@aws-sdk/client-s3` with two clients: an internal one (`S3_ENDPOINT`) for server-side calls, and a public one (`S3_PUBLIC_ENDPOINT`) that only signs URLs for the browser. Both use `requestChecksumCalculation: 'WHEN_REQUIRED'`.
- `QueueModule` (`src/queue/`) — BullMQ via `@nestjs/bullmq` (pinned to `^11`, since version 12 ships ESM-only) on Redis. It registers the `video-processing` queue and `VideoProcessingProducer`. Job names: `process-video` (`jobId = videoId`, 3 attempts, exponential backoff) and `cleanup-stale-uploads`.

### Videos (`src/videos/`)

All endpoints require authentication and are owner-only: a video that exists but belongs to someone else returns `404 VIDEO_NOT_FOUND`, never `403`. `VideosController` uses `@SkipThrottle()`, because a large upload needs many presign calls. Video bytes go straight from the client to MinIO through presigned URLs.

| Endpoint | Purpose |
|---|---|
| `POST /videos` | Initiate: pre-registers the video as a draft and opens the S3 multipart upload (`201`) |
| `POST /videos/:id/upload/parts` | Presigned `UploadPart` URLs for the requested part numbers |
| `GET /videos/:id/upload/parts` | List parts already stored (to resume an upload) |
| `POST /videos/:id/upload/complete` | Complete the multipart, check the size, enqueue `process-video` (`202`) |
| `DELETE /videos/:id/upload` | Cancel: abort the multipart (`204`) |
| `GET /videos/:id` | Video metadata (`thumbnail_url` only once `ready`) |
| `GET /videos/:publicId/stream` | `302` to a presigned GET of the original (`Cache-Control: no-store`) |
| `GET /videos/:publicId/download` | `302` to a presigned GET with `Content-Disposition: attachment` |

`:id` is the UUID. `:publicId` is the short public ID from `public-id.util.ts`; a malformed one returns `404` without a DB query. Stream and download return `409 VIDEO_NOT_READY` until the video is `ready`. Accepted formats are the allowlist in `src/videos/video-formats.ts`. Storage keys: `videos/{videoId}/original` in the `videos` bucket, and `thumbnails/{videoId}/default.jpg` in the `thumbnails` bucket.

**Status cycle.** `status` is always `draft` in this phase (publishing comes later). The lifecycle lives in `processing_status`:

```
uploading ──complete (size ok)──▶ processing ──worker ok──▶ ready
    │                                  │
    └─▶ failed                         └─▶ failed
        UPLOAD_CANCELLED (DELETE)          NOT_A_VIDEO | UNSUPPORTED_CONTAINER |
        UPLOAD_SIZE_MISMATCH (complete)    UNSUPPORTED_CODEC | CORRUPT_MEDIA (no retry)
        UPLOAD_ABANDONED (reconciler)      PROCESSING_FAILED (after 3 attempts, or reconciler)
```

Every transition is a conditional `UPDATE … WHERE processing_status = <expected>`, so a row in another state is never overwritten. The failure reason is stored in `processing_error`.

### Worker (`src/worker/`)

`WorkerModule` is the only module that registers a BullMQ `@Processor`. The API only produces jobs.

- `processors/video.processor.ts` — the single consumer of `video-processing`; dispatches by `job.name`. On the final failure it marks the video `failed`.
- `processors/video-processing.service.ts` — idempotent `process-video`. It skips videos that are not `processing`. It runs ffprobe on a presigned internal URL, validates the media, extracts a frame with ffmpeg, writes the deterministic thumbnail, and moves the video to `ready`. On a media failure it deletes the original and the thumbnails.
- `media/` — `MediaProbeService` (ffprobe) and `ThumbnailService` (ffmpeg), both via `execFile` with timeouts; the binaries come from `Dockerfile.dev`.
- `reconciler/` — `ReconcilerScheduler` registers the hourly `cleanup-stale-uploads` scheduler on boot (`upsertJobScheduler`, so there is always exactly one). `UploadReconcilerService` then runs three steps:
  1. aborts `uploading` uploads older than `UPLOAD_ABANDON_AFTER_HOURS` (`UPLOAD_ABANDONED`);
  2. handles `processing` videos older than `PROCESSING_STUCK_AFTER_MINUTES`, based on the state of their job: re-enqueue, mark `PROCESSING_FAILED`, or leave alone;
  3. deletes originals left behind by `failed` videos.

## Environment Variables

Validated by the Joi schema in `src/config/env.validation.ts`; `.env.example` lists the development values. Variables added for video upload and processing:

| Variable | Default | Purpose |
|---|---|---|
| `S3_ENDPOINT` | `http://minio:9000` | Server-side storage endpoint |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | Host that browser presigned URLs are signed for |
| `S3_REGION` | `us-east-1` | Signing region |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — (required) | Storage credentials |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style URLs (required by MinIO) |
| `S3_BUCKET_VIDEOS` / `S3_BUCKET_THUMBNAILS` | `videos` / `thumbnails` | Bucket names |
| `PRESIGNED_GET_TTL_SECONDS` | `14400` | Lifetime of stream/download URLs |
| `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | BullMQ connection |
| `BULLMQ_PREFIX` | `bull` | BullMQ key prefix (tests use a unique one per suite) |
| `UPLOAD_MAX_SIZE_BYTES` | `10737418240` (10 GiB) | Maximum `fileSize` on initiate |
| `UPLOAD_PART_SIZE_BYTES` | `16777216` (16 MiB) | Multipart part size (minimum 5 MiB) |
| `UPLOAD_ABANDON_AFTER_HOURS` | `24` | Reconciler threshold for `uploading` |
| `PROCESSING_STUCK_AFTER_MINUTES` | `60` | Reconciler threshold for `processing` |

The schema also validates `APP_URL` (default `http://localhost:3000`) and `SWAGGER_ENABLED` (default `false`). Neither is in `.env.example`.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
