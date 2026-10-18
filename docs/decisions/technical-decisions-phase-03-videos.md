---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-10-17
scope_description: "Backend + Docker infra for video upload and processing: queue technology, direct-to-storage multipart upload (≤10GB), MinIO internal/public endpoints, FFmpeg worker runtime, processing trigger, unique short video IDs, streaming/download delivery, status lifecycle with retries/idempotency/abandoned-upload cleanup, bucket/key layout, and test strategy for storage/queue/FFmpeg."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the upload handshake endpoints (initiate / sign parts / list parts / complete / abort), the `videos` domain (entity, status lifecycle, short public ID), the job producer, the video worker entrypoint (FFmpeg/ffprobe), and the stream/download endpoints.
- Docker infra (`nestjs-project/compose.yaml`, `Dockerfile.dev`, `.env.example`) — receives the object storage service (MinIO), the queue broker, the `video-worker` service, bucket provisioning, and the canonical env keys for storage/queue/upload limits.
- `next-frontend/` — Frontend deferred: the upload UI (part-by-part PUTs, resume, progress) and the player/download button are out of this phase. Cross-layer TDs below (TD-02, TD-04, TD-07, TD-08) fix the **contract** the frontend will consume later; no frontend implementation decision is open in this document.

_Inherited constraints (not reopened):_ PostgreSQL + TypeORM with migrations and `uuid` PKs (Fase 01); `@nestjs/config` + `registerAs` namespaces + Joi env schema (Fase 01 TD-01..TD-04); custom JWT guards with `@Public()` opt-out (Fase 02 TD-02); domain exceptions → `DomainExceptionFilter` error envelope (Fase 02 TD-07); `class-validator` DTOs (Fase 02 TD-06); `@nestjs/throttler` (Fase 02 TD-08); OpenAPI exported to `nestjs-project/openapi.json` (`openapi-docs-nestjs`). Object storage is **S3-compatible / MinIO** (architecture diagram) — this document only decides how it is used.

---

## TD-01: Queue Technology (job broker for video processing)

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the Message Queue as "TBD". The API must publish a processing job after upload and a separate worker must consume it with retries/backoff (TD-10) and a periodic cleanup job (TD-11). Hard constraint from the user: the queue must be a **real service in Compose** and **exercised by tests** (integration specs against the real broker, as with `db` and `mailpit`).

**Options:**

### Option A: BullMQ + Redis
- `bullmq` (v6.x) on a `redis` Compose service (Redis 8.x), integrated via `@nestjs/bullmq` (v12.x, peer `@nestjs/core ^11` — compatible). Producer: `@InjectQueue()` + `queue.add()`; consumer: `@Processor()` + `WorkerHost`.
- **Pros:** first-class Nest integration (`BullModule.forRootAsync` reads config namespace); native per-job `attempts` + exponential `backoff`, `UnrecoverableError`, `jobId` deduplication, stalled-job recovery, and **job schedulers** (`upsertJobScheduler`) for the cleanup cron — all of TD-10/TD-11 without extra infra. Easy to assert in tests (`queue.getJobs()`, `QueueEvents`, `queue.obliterate()` for isolation).
- **Cons:** adds Redis as a stateful dependency; Redis must run with `maxmemory-policy noeviction` and persistence (AOF) or jobs can be silently lost. Redis is single-purpose here (no other planned use).

### Option B: RabbitMQ (AMQP)
- `rabbitmq:management` Compose service; Nest via `@nestjs/microservices` (`Transport.RMQ`) or `@golevelup/nestjs-rabbitmq` (v9.x).
- **Pros:** robust broker, durable queues, acks, management UI; language-agnostic if a non-Node worker is ever wanted.
- **Cons:** no native delayed retry/backoff — requires DLX + per-queue TTL or the delayed-message plugin; no built-in job state/dedup by ID or cron schedules (TD-11 would need `@nestjs/schedule` + locking). `Transport.RMQ` is message-pattern oriented, not a job queue; more glue code for the same guarantees.

### Option C: pg-boss (PostgreSQL-backed)
- `pg-boss` (v12.x) stores jobs in a `pgboss` schema using `SKIP LOCKED`; supports retries, backoff, singleton keys and cron.
- **Pros:** zero new infrastructure — reuses PostgreSQL; transactional enqueue in the same DB transaction as the video row (true outbox semantics).
- **Cons:** **violates the stated constraint** — it would not add a real queue service to Compose (running a second Postgres just for the queue is artificial). No official Nest module (community wrappers only); job polling load lands on the main DB; requires Node ≥ 22.12 (fine with the `node:25` image).

**Recommendation:** Option A (BullMQ + Redis) — it is the only option that both satisfies the "real Compose service" constraint and natively covers retries/backoff, dedup by `jobId`, unrecoverable failures and scheduled cleanup (TD-10/TD-11) through an official `@nestjs/bullmq` module, keeping the worker code minimal; RabbitMQ would require building those semantics by hand. Canonical env keys: `REDIS_HOST=redis`, `REDIS_PORT=6379` (Compose service name per root CLAUDE.md).

**Decision:** _[pending]_

---

## TD-02: Large Upload Protocol (≤10GB direct to storage) — upload contract

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Bytes must not flow through the API (performance + memory), and `project-plan.md § Pontos de Atenção` requires the upload to be **resumable after connection failure**. Hard limits: AWS S3 single `PutObject` ≤ 5 GB; multipart parts 5 MiB–5 GiB (last part exempt from the minimum), ≤ 10,000 parts, part numbers 1–10,000. MinIO is more lenient (single PUT 5 TiB) — designing for MinIO-only limits would break on AWS S3 in production. Cross-layer because the handshake sequence (initiate → sign → PUT parts → complete) lives on both sides; the frontend implementation is deferred but the API contract is fixed here.

**Options:**

### Option A: Single presigned `PUT`
- API creates the draft and returns one presigned `PutObject` URL; client PUTs the whole file.
- **Pros:** simplest contract (one URL, one request); trivial backend.
- **Cons:** **exceeds AWS S3's 5 GB single-PUT limit** for 10GB files (works only on MinIO, i.e., dev/prod divergence); no resume — any network drop restarts from byte 0, failing the "retomar em caso de falha" requirement; no parallelism.

### Option B: S3 multipart upload with presigned URLs per part
- `POST /videos` (auth) creates the draft row (TD-09) + `CreateMultipartUpload`, returns `{ id, uploadId-backed session, partSize, partCount }`. Client asks `POST /videos/:id/upload/parts` for presigned `UploadPart` URLs for specific part numbers (batches, short TTL), PUTs each part directly to storage and keeps the `ETag`. Resume = `GET /videos/:id/upload/parts` (API calls `ListParts`) → client uploads only the missing ones. `POST /videos/:id/upload/complete` → `CompleteMultipartUpload` (API builds the part list from `ListParts`, not from client input) → `HeadObject` verifies size → enqueue (TD-06). `DELETE /videos/:id/upload` → `AbortMultipartUpload`.
- **Part size calculation (server-side, returned to client):** `partSize = max(UPLOAD_PART_SIZE_BYTES, ceil(fileSize / 10_000))` rounded up to a whole MiB, with `UPLOAD_PART_SIZE_BYTES` default 16 MiB (≥ 5 MiB S3 min); `partCount = ceil(fileSize / partSize)`. For 10 GiB: 16 MiB → 640 parts (well under 10,000; the `ceil(size/10000)` term only kicks in above ~156 GiB, so it is a guard, not the driver). `fileSize` declared by the client is validated against `UPLOAD_MAX_SIZE_BYTES` (10 GiB = 10737418240) at initiate **and** re-checked with `HeadObject.ContentLength` at complete (presigned PUTs cannot hard-enforce part size; an oversized object is rejected, aborted/deleted and marked failed).
- **Pros:** works within AWS and MinIO limits; resumable at part granularity; parallel parts; zero bytes through the API; standard S3 API only (portable).
- **Cons:** 5 endpoints and more client logic (chunking, ETag handling, retry per part); storage CORS must allow `PUT` and **expose `ETag`**; presigned URL TTL must cover part upload time; abandoned uploads leave orphan parts (TD-11).

### Option C: tus protocol (resumable uploads)
- A tus server receives chunks (`PATCH`) and stores them in S3 — either `@tus/server` + `@tus/s3-store` (v2.x) mounted in the API, or a separate `tusd` container with S3 backend + hooks notifying the API.
- **Pros:** open resumable protocol with mature clients (`tus-js-client`, Uppy); offsets tracked server-side; resume built into the protocol.
- **Cons:** with `@tus/server` in the API, **every byte passes through the API** (violates the requirement); with `tusd`, an extra service + hook-based integration for auth/draft creation, and bytes still pass through `tusd` (double hop to storage). Neither uses the storage's native direct upload.

**Recommendation:** Option B (S3 multipart with presigned per-part URLs) — it is the only option that keeps bytes off the API, is resumable, and respects the AWS limits (5 GB single PUT, 10,000 parts) that will apply in production; server-computed `partSize` with a 16 MiB default keeps 10 GiB at 640 parts while the `ceil(size/10000)` guard keeps the formula valid if the max size grows. Endpoints are documented in `openapi.json` for the deferred frontend.

**Decision:** _[pending]_

---

## TD-03: S3 Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** API and worker need: multipart operations (`Create/List/Complete/AbortMultipartUpload`), presigning `UploadPart` and `GetObject` (with response header overrides), `HeadObject`, `PutObject` (thumbnail), bucket bootstrap. The MinIO server project was archived in Feb 2026 (see Notes), which raises the value of staying on the plain S3 API so the backend is not coupled to one vendor's SDK.

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, v3.11xx)
- Modular official SDK; `getSignedUrl(client, new UploadPartCommand(...))`; `forcePathStyle: true` for MinIO.
- **Pros:** canonical S3 implementation, works against AWS, MinIO, and any S3-compatible replacement; full multipart + presign coverage with types; actively maintained.
- **Cons:** since early 2025 the SDK computes CRC32 checksums by default (`requestChecksumCalculation: 'WHEN_SUPPORTED'`), which breaks presigned uploads on several S3-compatible servers — client must be configured with `requestChecksumCalculation: 'WHEN_REQUIRED'` / `responseChecksumValidation: 'WHEN_REQUIRED'`; heavier dependency tree.

### Option B: MinIO JS client (`minio` v8.x)
- `presignedUrl('PUT', bucket, key, ttl, { partNumber, uploadId })`, `initiateNewMultipartUpload`, etc.
- **Pros:** smaller API surface; MinIO-flavored defaults (path style).
- **Cons:** tied to an archived upstream project; presigned multipart is done via low-level request params rather than typed commands; weaker guarantee of continued maintenance against AWS S3.

**Recommendation:** Option A (AWS SDK v3) — it is the vendor-neutral S3 implementation, so swapping MinIO for AWS S3 or another S3-compatible server (a real possibility given MinIO CE's archival) is a config change, not a rewrite; the checksum default is a known one-line client setting.

**Decision:** _[pending]_

---

## TD-04: MinIO Internal vs Public Endpoint for Presigned URLs

**Scope:** Cross-layer

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** SigV4 signs the `Host` header. Inside Compose the API/worker reach storage at `http://minio:9000` (root CLAUDE.md forbids `localhost` between containers), but the browser reaches it at `http://localhost:9000` (prod: a public domain/CDN). A URL signed for `minio:9000` is unreachable from the browser; rewriting the host after signing invalidates the signature (`SignatureDoesNotMatch`). Cross-layer: the frontend consumes the URLs the API produces.

**Options:**

### Option A: Two S3 client instances — internal for I/O, public for presigning
- `S3_ENDPOINT=http://minio:9000` client performs all network calls (multipart create/list/complete, head, put thumbnail); a second client configured with `S3_PUBLIC_ENDPOINT=http://localhost:9000` is used **only** to presign browser-facing URLs. Presigning is an offline HMAC computation — the public client never opens a connection, so it does not need to resolve `localhost` from inside the container.
- **Pros:** no DNS/network tricks; works identically in dev and prod (prod sets `S3_PUBLIC_ENDPOINT` to the public domain); internal traffic stays on the Compose network; the worker presigns with the internal client for its own FFmpeg reads (TD-05).
- **Cons:** two clients to wire (a small `StorageService` factory hides it); env must keep both endpoints consistent.

### Option B: Single hostname resolvable from both sides
- Make the same host valid everywhere, e.g., the API uses `host.docker.internal:9000` / `extra_hosts: host-gateway`, or the developer adds `127.0.0.1 minio` to `/etc/hosts` so the browser uses `minio:9000`.
- **Pros:** one client, one endpoint.
- **Cons:** depends on per-machine setup (`/etc/hosts`) or Docker-Desktop-specific DNS; routes internal traffic through the host's published port; breaks the "service name only" convention and differs between dev and prod.

### Option C: Reverse proxy with a fixed public host
- An `nginx`/`traefik` service fronts MinIO at e.g. `storage.localhost`, preserving `Host`; both API (via network alias) and browser use that host.
- **Pros:** mirrors a production CDN/ingress topology; one canonical storage URL.
- **Cons:** extra Compose service and config only to solve signing; proxy must not alter `Host` or buffer 10GB uploads (proxy body limits/timeouts); more moving parts in tests.

**Recommendation:** Option A (internal client for I/O + public client only for presigning) — it fixes the signature/host mismatch with configuration alone, keeps container traffic on Compose service names as mandated, and maps 1:1 to production. Canonical env keys (Joi schema + `compose.yaml` + `.env.example`): `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE`, plus bucket names from TD-12. Storage CORS must allow the frontend origin with `GET, PUT, HEAD` and expose `ETag` (required by TD-02).

**Decision:** _[pending]_

---

## TD-05: Video Worker Runtime and FFmpeg Integration

**Scope:** Repo-wide

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The diagram defines a separate "Video Worker (FFmpeg)" container. Processing must not compete with API request handling ("sem impacto na performance"). The worker needs the `Video` entity/repository, storage service, and queue config — all of which live in `nestjs-project/`. It also needs `ffprobe` (duration, codec, resolution, bitrate) and `ffmpeg` (one frame → JPEG). Repo-wide because it shapes Compose services, Dockerfile, npm scripts and module layout.

**Options:**

### Option A: Same codebase, separate entrypoint and container (NestJS standalone application context)
- `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server); `WorkerModule` imports shared `VideosModule`/`StorageModule` + the `@Processor`. Compose adds a `video-worker` service from the same image with `ffmpeg` installed, running `npm run start:worker:dev`.
- **Pros:** reuses entities, migrations, config namespaces, Joi schema and storage service with zero duplication; one `package.json`, one lint/tsc/test pipeline (Definition of Done stays single); independent scaling and resource limits per container; API process never loads FFmpeg work.
- **Cons:** module boundaries must keep HTTP-only modules out of `WorkerModule`; API image also carries ffmpeg if a single dev image is used (acceptable in dev; prod images can split later in Fase 07).

### Option B: Processor inside the API process
- `@Processor` registered in `AppModule`; the API container runs both HTTP and jobs.
- **Pros:** simplest setup — no new service or entrypoint.
- **Cons:** FFmpeg CPU/IO competes with HTTP handling — contradicts the capability's "sem impacto na performance" and the diagram's separate worker container; cannot scale workers independently.

### Option C: Separate project (e.g., `video-worker/` subproject)
- Independent Node (or other language) project with its own manifest, DB access and storage client.
- **Pros:** strongest isolation; free stack choice for the worker.
- **Cons:** duplicates entities/status enum/config/env validation (drift risk on the `videos` schema shared with the API); a second toolchain and test suite; monorepo tooling questions not yet decided.

**FFmpeg invocation (sub-decision, applies to A/C):** call the binaries with `child_process.execFile` (no shell, args array) — `ffprobe -v error -print_format json -show_format -show_streams <input>` parsed into typed metadata, and `ffmpeg -ss <t> -i <input> -frames:v 1 -vf scale=1280:-2 <out.jpg>` (`-ss` before `-i` for fast seek; `t` ≈ 10% of duration, clamped). `fluent-ffmpeg` is **deprecated/unmaintained** (npm notice) and not recommended. `<input>` is a presigned GET URL signed with the **internal** endpoint: ffprobe/ffmpeg read over HTTP with Range requests, so the worker does not download 10GB to local disk (fallback to a temp-file download only if a container format proves unseekable).

**Recommendation:** Option A (same codebase, `createApplicationContext` entrypoint, dedicated `video-worker` container with ffmpeg) using `execFile` over presigned internal URLs — it isolates CPU-heavy work from the API as the capability requires while keeping a single source of truth for the `videos` schema and a single Definition-of-Done pipeline.

**Decision:** _[pending]_

---

## TD-06: Processing Trigger

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Something must enqueue the processing job once the object is fully in storage. Depends on TD-01 (queue) and TD-02 (upload protocol).

**Options:**

### Option A: API "complete upload" endpoint enqueues the job
- `POST /videos/:id/upload/complete` performs `CompleteMultipartUpload` + `HeadObject` check, transitions status to `processing` (TD-09) and calls `queue.add('process-video', { videoId }, { jobId: videoId })`.
- **Pros:** single, explicit, authenticated transition owned by the API; the endpoint is already required by multipart (someone must call `CompleteMultipartUpload`); easy to test end-to-end (assert job in Redis); portable to any S3-compatible storage.
- **Cons:** DB update and enqueue are two systems — a crash between them leaves a `processing` row with no job (mitigated by the reconciler in TD-11 and idempotent re-enqueue via `jobId`).

### Option B: MinIO bucket notifications
- Configure MinIO to emit `s3:ObjectCreated:CompleteMultipartUpload` events to a target (webhook to the API, Redis, AMQP…); a consumer maps the event to a job.
- **Pros:** storage is the source of truth for "object exists"; fires even if the client never calls complete (but with multipart, the object only exists after someone calls complete anyway).
- **Cons:** MinIO's Redis target writes its own event format (not a BullMQ job) → an adapter is still needed; configuration via `mc admin`/env on an archived server; not portable (AWS uses S3 Event Notifications → SQS/SNS/Lambda); duplicate/out-of-order events must be deduplicated; thumbnails written by the worker would also emit events unless filtered by prefix.

**Recommendation:** Option A (complete endpoint enqueues) — with presigned multipart the API must call `CompleteMultipartUpload` anyway, so it is the natural point to validate size and enqueue; it keeps the trigger inside tested application code and storage-vendor-neutral, and the crash window is covered by `jobId` dedup + the TD-11 reconciler.

**Decision:** _[pending]_

---

## TD-07: Unique Video URL Strategy (public ID shape)

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** `project-plan.md § Pontos de Atenção` asks for a **short** URL that never conflicts. Existing entities use `uuid` PKs. The ID appears in API routes (`/videos/:publicId/...`) and future frontend routes (`/watch/:publicId`), so the shape is a cross-layer contract. Title editing arrives in Fase 04.

**Options:**

### Option A: Expose the UUID PK
- URL uses the existing `uuid` (`/videos/3f1c…`).
- **Pros:** zero extra column/logic; already unique.
- **Cons:** 36 chars — not "short"; leaks the internal PK into URLs.

### Option B: Random short ID (base62) + unique constraint + retry on collision
- Separate `public_id varchar(11) UNIQUE` generated with `node:crypto` (`randomInt` over a 62-char alphabet, ~65 bits); on unique-violation (`23505`) retry up to N times. UUID remains the PK/FK.
- **Pros:** short, YouTube-like, non-enumerable (unlisted videos in Fase 05 rely on unguessable links); collision probability negligible (62¹¹ ≈ 5.2×10¹⁹) and handled deterministically by the DB constraint; stable when title changes. Using `node:crypto` avoids `nanoid` v5+/v6 being ESM-only in this CommonJS + ts-jest project.
- **Cons:** extra column + small generator util and retry loop (tested like `nickname.util`).

### Option C: Slug from title
- `meu-video-legal` (+ suffix on conflict).
- **Pros:** human-readable, SEO-friendly.
- **Cons:** title is unknown/placeholder at upload time and editable in Fase 04 → URL changes or diverges from title; conflict suffixing is racy; guessable (bad for unlisted).

### Option D: Encoded sequential ID (Sqids/Hashids over a serial)
- Short string derived from a `bigserial`.
- **Pros:** guaranteed unique without retry; short.
- **Cons:** reversible/enumerable if the alphabet leaks (weak for unlisted); requires a serial column alongside the uuid PK and a library dependency.

**Recommendation:** Option B (11-char base62 `public_id` with unique constraint + retry, UUID kept as PK) — it satisfies "short and never conflicting" with the DB as the uniqueness authority, stays stable across Fase 04 title edits, and is unguessable for Fase 05 unlisted links.

**Decision:** _[pending]_

---

## TD-08: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file — i.e., HTTP Range/206 must work. S3/MinIO already answer `Range` with `206 Partial Content`. Anonymous viewers are allowed (access rules for draft/unlisted evolve in Fases 04/05). The diagram already shows "Frontend → Object Storage: Streams". Download must force a save dialog with the original filename.

**Options:**

### Option A: API authorizes, then `302` redirect to a short-lived presigned GET
- `GET /videos/:publicId/stream` checks status/visibility and redirects to a presigned `GetObject` URL (public endpoint, TD-04); `<video src>` follows the redirect and issues Range requests directly to storage. `GET /videos/:publicId/download` does the same with `ResponseContentDisposition: attachment; filename*=UTF-8''<original>` (and `ResponseContentType`) baked into the signature.
- **Pros:** zero video bytes through the API; Range/206/seek handled by storage; download filename/disposition without proxying; authorization stays in the API; prod can swap storage URL for a CDN.
- **Cons:** presigned TTL must exceed typical viewing time (an expired URL makes later Range requests fail → player must re-request the stream endpoint); URLs are shareable until expiry.

### Option B: API proxies bytes with Range support
- API reads `Range`, calls `GetObject` with the same range and pipes the stream back with `206`.
- **Pros:** URL never exposes storage; per-request authorization.
- **Cons:** every byte of every view flows through the Node process — directly against "sem impacto na performance"; must re-implement Range parsing, `Content-Range`, `If-Range`, and abort handling correctly.

### Option C: Public-read bucket with direct object URLs
- Videos bucket is anonymous-readable; API returns the plain object URL.
- **Pros:** simplest; cache/CDN friendly.
- **Cons:** no authorization at all — drafts/processing videos and future unlisted rules cannot be enforced; keys become permanent public links; download disposition cannot be set per request.

**Recommendation:** Option A (authorize in API, `302` to presigned GET; download via signed `response-content-disposition: attachment`) — storage already implements Range/206 so streaming works without bytes touching Node, while the API keeps control over who may watch; TTL is an env key (`PRESIGNED_GET_TTL_SECONDS`) sized for long videos. Note: no transcoding/HLS in this phase — progressive MP4 playback starts fastest when the `moov` atom is at the front; files without it still play via Range seek.

**Decision:** _[pending]_

---

## TD-09: Video Status Model (draft → processing → ready/failed)

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The video row is created as a draft when the upload starts (TD-02) and moves through upload and processing. Fase 04 adds the editorial "rascunho → publicação" flow and visibility (public/unlisted). Mixing technical processing state with editorial state in one column would force Fase 04 to redesign it (e.g., a `ready` video can still be a draft; a published video can be re-processed).

**Options:**

### Option A: Single `status` enum
- `draft (uploading) → processing → ready | failed`, later extended with `published`.
- **Pros:** one column, simple queries in this phase.
- **Cons:** conflates two lifecycles; Fase 04 needs states like "draft + ready" vs "published + ready" → enum explosion or a migration that splits the column anyway.

### Option B: Two orthogonal columns
- `processing_status`: `uploading → processing → ready | failed` (owned by upload/worker). `status` (editorial): `draft` default (Fase 04 adds `published` + `visibility`). Created in this phase as `status=draft, processing_status=uploading`.
- **Pros:** each column has a single owner and transition set (API owns `uploading→processing`, worker owns `processing→ready|failed`); Fase 04 extends `status` without touching processing; conditional updates (`WHERE processing_status='processing'`) give idempotency for TD-10.
- **Cons:** two enums and slightly more validation logic (e.g., cannot publish until `ready` — Fase 04 rule).

**Recommendation:** Option B (separate `processing_status` and editorial `status=draft`) — it satisfies "pré-cadastro como rascunho" literally while giving the worker a state machine it owns, and avoids a breaking schema change when Fase 04 introduces publication and visibility.

**Decision:** _[pending]_

---

## TD-10: Job Retry, Backoff and Idempotency Policy

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Processing can fail transiently (storage/DB hiccup, worker restart → stalled job) or permanently (file is not a valid video). Jobs may run more than once (retries, stalled recovery, duplicate `complete` calls). Depends on TD-01 and TD-09.

**Options:**

### Option A: Broker-native retries + idempotent processor
- Job added with `jobId = videoId`, `attempts: 3`, `backoff: { type: 'exponential', delay: 10_000 }`. Invalid media (ffprobe finds no video stream / non-zero exit on parse) throws `UnrecoverableError` → no retry. Processor is idempotent: skips if `processing_status` is already `ready`; thumbnail key is deterministic (overwritten, not duplicated); final update is conditional (`UPDATE … WHERE id=? AND processing_status='processing'`). On final failure (`attemptsMade ≥ attempts` or unrecoverable) the worker sets `processing_status=failed` + `processing_error`.
- **Pros:** retries/backoff/stalled recovery come from the queue; `jobId` dedups double enqueue; deterministic outputs make re-runs safe; failure is visible on the entity.
- **Cons:** `jobId` dedup only holds while the job record exists — completed/failed retention (`removeOnComplete/removeOnFail` age) must be long enough, or re-enqueue relies on the status check; attempt values are tuning knobs to validate.

### Option B: No automatic retry; manual reprocess
- Job runs once; failure → `failed`; owner triggers `POST /videos/:id/reprocess`.
- **Pros:** predictable, minimal configuration.
- **Cons:** transient errors become user-visible failures; needs an extra endpoint and UX; still needs idempotency for duplicate enqueues.

### Option C: Application-managed attempts in the DB
- `processing_attempts` column; worker increments and re-enqueues with `delay` manually.
- **Pros:** attempts visible in SQL; broker-agnostic.
- **Cons:** reimplements what BullMQ provides (only justified if TD-01 were not BullMQ); more code paths to test.

**Recommendation:** Option A (BullMQ `attempts`/exponential backoff + `UnrecoverableError` for invalid media + idempotent, conditional writes keyed by `videoId`) — it uses the queue features chosen in TD-01 and relies on the TD-09 state machine for correctness, so duplicates and retries are harmless.

**Decision:** _[pending]_

---

## TD-11: Abandoned Multipart Uploads and Stuck Videos Cleanup

**Scope:** Backend

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Users will close the tab mid-upload: parts already stored consume space and the draft row stays `uploading` forever. A crash between "status=processing" and enqueue (TD-06) leaves a row without a job. MinIO expires stale multipart uploads on its own (`MINIO_API_STALE_UPLOADS_EXPIRY`, default `24h`, scanned every `MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL`, default `6h`); AWS S3 uses a lifecycle rule `AbortIncompleteMultipartUpload`. Neither touches the DB row.

**Options:**

### Option A: Storage-level expiry only
- Rely on MinIO stale-upload expiry (prod: S3 lifecycle rule).
- **Pros:** zero application code.
- **Cons:** DB keeps orphan `uploading` drafts forever (they will show up in the Fase 04 channel panel); no recovery for `processing` rows without a job; behavior differs per storage vendor.

### Option B: Application reconciler job + storage expiry as safety net
- A BullMQ job scheduler (`upsertJobScheduler`, e.g., hourly) runs in the worker: videos `uploading` older than `UPLOAD_ABANDON_AFTER_HOURS` (e.g., 24h) → `AbortMultipartUpload` + mark `failed` (or delete the draft); videos `processing` with no active job older than a threshold → re-enqueue (idempotent via TD-10). MinIO/S3 expiry remains configured as a backstop. Resume window = presigned per-part requests allowed until the abandon threshold.
- **Pros:** DB and storage converge; closes TD-06's crash window; exercised by tests through the real queue; vendor-neutral.
- **Cons:** one more scheduled job and thresholds to tune; must not abort uploads still being resumed (threshold > max reasonable resume gap).

### Option C: Cleanup only on explicit user action
- Only `DELETE /videos/:id/upload` aborts; nothing automatic.
- **Pros:** simplest.
- **Cons:** the common case (tab closed) never calls it — orphans accumulate.

**Recommendation:** Option B (scheduled reconciler in the worker + storage-level expiry as backstop) — it is the only option that keeps the `videos` table consistent with storage and recovers stuck jobs, reusing the queue scheduler from TD-01 instead of adding `@nestjs/schedule`.

**Decision:** _[pending]_

---

## TD-12: Bucket and Object Key Organization

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage is decided (S3-compatible/MinIO); layout and access policy are not. Bucket names are cross-component (env schema + Compose provisioning + API + worker). Thumbnails will be rendered in many listings (Fases 04/07), where presigning every image per request has a cost; videos must stay private (TD-08). Keys must not depend on mutable data (title, filename) or on `public_id`.

**Options:**

### Option A: Single private bucket with prefixes
- `streamtube/videos/{videoId}/original`, `streamtube/thumbnails/{videoId}/auto.jpg`; everything served via presigned GET.
- **Pros:** one bucket to provision and configure; uniform access model.
- **Cons:** listing pages must presign N thumbnail URLs per request (signatures expire → poor cache behavior); per-prefix public policies are possible but easier to get wrong.

### Option B: Two buckets — `videos` (private) and `thumbnails` (anonymous read)
- `videos/{videoId}/original` (private, presigned only); `thumbnails/{videoId}/auto.jpg` (later `custom.jpg` in Fase 04) with a read-only anonymous bucket policy, URL = `${S3_PUBLIC_ENDPOINT}/thumbnails/...`.
- **Pros:** clear security boundary per bucket; thumbnails are cacheable stable URLs for listings; `videoId` (UUID) keys are unguessable, so an unlisted video's thumbnail is not discoverable by enumeration.
- **Cons:** two buckets + one bucket policy to provision; a thumbnail of a draft is technically readable by anyone who knows its key.

### Option C: Per-channel hierarchy
- `{channelId}/videos/{videoId}/...` in one bucket.
- **Pros:** easy per-channel usage accounting/deletion.
- **Cons:** keys break if ownership model changes; no benefit for access control over A/B; accounting can be done in SQL.

**Provisioning (applies to all):** buckets and the thumbnails policy are created idempotently at stack start by a one-shot Compose service (`createbuckets`, using a pinned `mc` image) so dev and tests start from the same state; bucket names via env (`S3_BUCKET_VIDEOS`, `S3_BUCKET_THUMBNAILS`). Original filename and MIME type are stored in the DB (needed by TD-08 download), never in the key.

**Recommendation:** Option B (private `videos` bucket + anonymous-read `thumbnails` bucket, keys by `videoId` UUID) — it keeps video access fully mediated by the API while giving listings cheap, cacheable thumbnail URLs, and the UUID key prevents enumeration.

**Decision:** _[pending]_

---

## TD-13: Test Strategy for Storage, Queue and FFmpeg

**Scope:** Repo-wide

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The user requires the queue to be exercised by tests. The current `testing-guide-nestjs-project` skill (`references/external-systems.md`) prescribes a **local-filesystem storage adapter** for tests, which cannot exercise presigned multipart, `ListParts`, `CompleteMultipartUpload` or Range GETs — the core of this phase. Tests run inside the `nestjs-api` container with `--runInBand` against shared services; FFmpeg must be present where tests run.

**Options:**

### Option A: Real services in Compose for integration/e2e
- Integration specs hit real MinIO (dedicated test buckets, e.g., `S3_BUCKET_*` suffixed `-test`, emptied in `beforeEach`), real Redis (BullMQ `prefix` per test run + `queue.obliterate({ force: true })` cleanup) and real ffmpeg/ffprobe on a tiny fixture generated with `ffmpeg -f lavfi -i testsrc` (or a committed few-KB MP4). The dev image gets `ffmpeg` so both `nestjs-api` and `video-worker` can run worker-processor specs. Unit specs mock the `StorageService`/queue boundary per the skill's mock-boundary rule.
- **Pros:** proves the real contracts (signatures, multipart, Range/206, job delivery, retries) — consistent with how `db` and `mailpit` are already tested; satisfies the "exercised by tests" constraint literally.
- **Cons:** slower suites; more cleanup discipline; requires updating the testing-guide skill (storage section) to match.

### Option B: Local-filesystem storage adapter + real Redis
- Keep the skill's current guidance: a `local` driver for storage in tests; real Redis for queue.
- **Pros:** fast; no MinIO in tests.
- **Cons:** cannot test presigned multipart, ETag/ListParts or Range behavior — the phase's riskiest paths go untested; an adapter abstraction exists only for tests.

### Option C: Testcontainers per suite
- Spin MinIO/Redis containers from Jest.
- **Pros:** full isolation per suite.
- **Cons:** tests already run inside a container (Docker-in-Docker / socket mounting); diverges from the established Compose-service testing pattern; slower startup.

**Recommendation:** Option A (real MinIO + Redis + ffmpeg via Compose, isolated by test buckets and BullMQ prefix) — it matches the project's existing real-service testing pattern (`db`, `mailpit`) and is the only option that verifies the multipart/presign/Range contracts this phase depends on; the testing-guide skill's storage section should be updated accordingly as part of implementation.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue technology | A — BullMQ + Redis (`@nestjs/bullmq`) | _[pending]_ |
| TD-02 | Cross-layer | Large upload protocol (≤10GB) — upload contract | B — S3 multipart, presigned URL per part, server-computed `partSize` (16 MiB default) | _[pending]_ |
| TD-03 | Backend | S3 client library | A — AWS SDK v3 (`client-s3` + `s3-request-presigner`) | _[pending]_ |
| TD-04 | Cross-layer | MinIO internal vs public endpoint | A — internal client for I/O + public client only for presigning | _[pending]_ |
| TD-05 | Repo-wide | Worker runtime & FFmpeg integration | A — same codebase, `createApplicationContext` entrypoint, `video-worker` container, `execFile` over presigned URL | _[pending]_ |
| TD-06 | Backend | Processing trigger | A — "complete upload" endpoint enqueues | _[pending]_ |
| TD-07 | Cross-layer | Unique video URL (public ID shape) | B — 11-char base62 `public_id`, unique + retry, UUID PK kept | _[pending]_ |
| TD-08 | Cross-layer | Streaming & download delivery | A — `302` to presigned GET; download via signed `Content-Disposition: attachment` | _[pending]_ |
| TD-09 | Backend | Video status model | B — `processing_status` + editorial `status=draft` | _[pending]_ |
| TD-10 | Backend | Job retry/backoff/idempotency | A — BullMQ attempts + exponential backoff + `UnrecoverableError` + idempotent writes (`jobId=videoId`) | _[pending]_ |
| TD-11 | Backend | Abandoned uploads & stuck videos cleanup | B — scheduled reconciler (BullMQ job scheduler) + storage expiry backstop | _[pending]_ |
| TD-12 | Repo-wide | Bucket & key organization | B — private `videos` + anonymous-read `thumbnails`, keys by `videoId` | _[pending]_ |
| TD-13 | Repo-wide | Test strategy for storage/queue/FFmpeg | A — real MinIO + Redis + ffmpeg in Compose, isolated test buckets/prefix | _[pending]_ |

**Dependencies:** TD-02 → TD-04, TD-06, TD-11; TD-06 → TD-01, TD-09; TD-10 → TD-01, TD-09; TD-11 → TD-01, TD-02, TD-10; TD-08 → TD-04, TD-12; TD-05 → TD-03, TD-04; TD-13 → TD-01, TD-05, TD-12.

---

## Notes and Risks

- **MinIO Community Edition is no longer maintained upstream.** Community Docker images stopped being published in late 2025, the repo entered maintenance mode in Dec 2025 and was archived in Feb 2026 (the CVE-2025-62506 fix shipped only in the last release). This document does **not** reopen the storage choice (S3-compatible/MinIO is decided); it mitigates by (a) pinning an exact MinIO image tag — never `latest` — and verifying it includes the final security fixes, and (b) using only the plain S3 API via AWS SDK v3 (TD-03), so moving to AWS S3 or another S3-compatible server is a config change. If the team wants to revisit the storage server itself, open it via `/decide`.
- **AWS SDK v3 checksum defaults** must be set to `WHEN_REQUIRED` on the clients that presign, otherwise presigned PUTs can fail with signature/checksum errors on S3-compatible servers (TD-03).
- **No transcoding/HLS** in this phase: the capability is satisfied by progressive MP4 playback over Range requests (TD-08). Adaptive streaming would be a future-phase decision.
- **Testing-guide skill drift:** `references/external-systems.md` (local-FS storage in tests) conflicts with TD-13's recommendation; update it during implementation if TD-13 is accepted.

_Sources:_ AWS S3 multipart limits (docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html); AWS single-PUT 5 GB limit (S3 user guide, "Uploading objects"); MinIO limits (`minio/docs/minio-limits.md`: single PUT 5 TiB, 10,000 parts, part 5 MiB–5 TiB) and config (`MINIO_API_STALE_UPLOADS_EXPIRY` 24h / `..._CLEANUP_INTERVAL` 6h); AWS SDK data-integrity defaults (docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html); `fluent-ffmpeg` npm deprecation notice; npm registry versions as of 2026-10-17 (`bullmq` 6.3.x, `@nestjs/bullmq` 12.0.0 with peer `@nestjs/core ^11`, `pg-boss` 12.38, `@aws-sdk/client-s3` 3.1152, `minio` 8.0.7, `@tus/server` 2.4, `nanoid` 6.0 ESM-only).
