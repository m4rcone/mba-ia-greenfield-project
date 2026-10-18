---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-17T22:46:49-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-18T02:49:34-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-17T22:46:49-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-17T22:46:49-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-17T22:46:49-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-17T22:46:49-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-18T02:44:40-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-18T02:50:15-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** _None named explicitly in the phase body._
**Deferred subprojects:** _None._
**Sequencing notes:** "> Depende de: Fase 01, Fase 02". Intro sentence: "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — "> Depende de: Fase 01"
- **Phase 04:** Gerenciamento de Vídeos e Canal — "> Depende de: Fase 02, Fase 03"

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Queue Technology (job broker for video processing) | decided | A (BullMQ + Redis) | bullmq, @nestjs/bullmq, ioredis |
|     └─ Last revision: 2026-10-18 — `@nestjs/bullmq` is pinned to `^11.0.5` instead of the `v12.x` named in Option… | | | | | | |
| phase-03-videos/TD-02 | phase | Cross-layer | Large Upload Protocol (≤10GB direct to storage) | decided | B (S3 multipart upload, presigned URL per part) | — |
|     └─ Last revision: 2026-10-18 — Pins the verifiable acceptance criterion for "sem impacto na performance": th… | | | | | | |
| phase-03-videos/TD-03 | phase | Backend | S3 Client Library | decided | A (AWS SDK for JavaScript v3) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-04 | phase | Cross-layer | MinIO Internal vs Public Endpoint for Presigned URLs | decided | A (two S3 clients: internal for I/O, public for presigning) | — |
|     └─ Last revision: 2026-10-18 — Storage CORS is configured **server-wide** on the `minio` Compose service… | | | | | | |
| phase-03-videos/TD-05 | phase | Repo-wide | Video Worker Runtime and FFmpeg Integration | decided | A (same codebase, separate entrypoint/container, NestJS standalone context) | — |
| phase-03-videos/TD-06 | phase | Backend | Processing Trigger | decided | A (the API "complete upload" endpoint enqueues the job) | — |
| phase-03-videos/TD-07 | phase | Cross-layer | Unique Video URL Strategy (public ID shape) | decided | B (random short base62 ID + unique constraint + retry on collision) | — |
| phase-03-videos/TD-08 | phase | Cross-layer | Streaming and Download Delivery | decided | A (API authorizes, then 302 to a short-lived presigned GET) | — |
|     └─ Last revision: 2026-10-18 — Fixes the Phase 03 access rule: `/stream` and `/download` are authenticated and… | | | | | | |
| phase-03-videos/TD-09 | phase | Backend | Video Status Model (draft → processing → ready/failed) | decided | B (two orthogonal columns) | — |
|     └─ Last revision: 2026-10-18 — Clarifies that "rascunho" in the pre-registration capability is the editorial… | | | | | | |
| phase-03-videos/TD-10 | phase | Backend | Job Retry, Backoff and Idempotency Policy | decided | A (broker-native retries + idempotent processor) | — |
| phase-03-videos/TD-11 | phase | Backend | Abandoned Multipart Uploads and Stuck Videos Cleanup | decided | B (app reconciler job + storage expiry as safety net) | — |
| phase-03-videos/TD-12 | phase | Repo-wide | Bucket and Object Key Organization | decided | B (two buckets: `videos` private, `thumbnails` anonymous read) | — |
| phase-03-videos/TD-13 | phase | Repo-wide | Test Strategy for Storage, Queue and FFmpeg | decided | A (real services in Compose for integration/e2e) | — |
|     └─ Last revision: 2026-10-18 — The official `minio/minio` and `minio/mc` images are no longer published on… | | | | | | |
| phase-03-videos/TD-14 | phase | Cross-layer | Accepted Video Formats and Upload Content-Validation Strategy | decided | C (layered: declared allowlist at initiate + ffprobe in worker) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-12, phase-03-videos/TD-13 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-10, phase-03-videos/TD-13 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-04, phase-03-videos/TD-11, phase-03-videos/TD-14 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-09, phase-03-videos/TD-11 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-09, phase-03-videos/TD-10, phase-03-videos/TD-13, phase-03-videos/TD-14 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-10, phase-03-videos/TD-13 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04, phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-04, phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** it is the only option that both satisfies the "real Compose service" constraint and natively covers retries/backoff, dedup by `jobId`, unrecoverable failures and scheduled cleanup (TD-10/TD-11) through an official `@nestjs/bullmq` module, keeping the worker code minimal; RabbitMQ would require building those semantics by hand. Canonical env keys: `REDIS_HOST=redis`, `REDIS_PORT=6379` (Compose service name per root CLAUDE.md).
**Libraries:** bullmq, @nestjs/bullmq, ioredis

**Revisions:**
- 2026-10-18 — `@nestjs/bullmq` is pinned to `^11.0.5` instead of the `v12.x` named in Option A. Version 12.0.0 ships ESM-only (`"type": "module"`), so the project's CommonJS + ts-jest setup cannot load it. 11.0.5 is CommonJS, declares peers `@nestjs/core ^10 || ^11` and `bullmq ^3 || ^4 || ^5 || ^6`, and exposes the same API this phase uses (`BullModule.forRootAsync` with `connection`, `registerQueue`, `@Processor` + `WorkerHost`, `@OnWorkerEvent`). BullMQ v6 made `ioredis` an optional peer dependency that Redis users must install explicitly, so `ioredis@^5.11.1` is a direct dependency and joins **Libraries**. Upgrade `@nestjs/bullmq` together with a future ESM or Nest 12 migration. Rationale: implementation finding in phase-03 SI-03.6 (deviation approved by the user); the queue choice itself is unchanged.

### phase-03-videos/TD-02

**Recommendation:** it is the only option that keeps bytes off the API, is resumable, and respects the AWS limits (5 GB single PUT, 10,000 parts) that will apply in production; server-computed `partSize` with a 16 MiB default keeps 10 GiB at 640 parts while the `ceil(size/10000)` guard keeps the formula valid if the max size grows. Endpoints are documented in `openapi.json` for the deferred frontend.
**Libraries:** —

**Revisions:**
- 2026-10-18 — Pins the verifiable acceptance criterion for "sem impacto na performance": the API process never receives or buffers video bytes (all parts go directly to object storage via presigned URLs) and API memory stays flat during an upload, regardless of file size; no concurrency target is set for this phase. Rationale: resolves phase-03 validation AMB-3 — the capability needed a testable property.

### phase-03-videos/TD-03

**Recommendation:** it is the vendor-neutral S3 implementation, so swapping MinIO for AWS S3 or another S3-compatible server (a real possibility given MinIO CE's archival) is a config change, not a rewrite; the checksum default is a known one-line client setting.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-04

**Recommendation:** it fixes the signature/host mismatch with configuration alone, keeps container traffic on Compose service names as mandated, and maps 1:1 to production. Canonical env keys (Joi schema + `compose.yaml` + `.env.example`): `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE`, plus bucket names from TD-12. Storage CORS must allow the frontend origin with `GET, PUT, HEAD` and expose `ETag` (required by TD-02).
**Libraries:** —

**Revisions:**
- 2026-10-18 — Storage CORS is configured **server-wide** on the `minio` Compose service (`MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3001`), not per bucket in the provisioning step. MinIO does not implement bucket-level CORS (`PutBucketCors`), so the rule applies to every bucket. During SI-03.1 we verified that the preflight allows `GET`, `PUT` and `HEAD`, exposes `ETag`, and rejects other origins. `http://localhost:3001` is the frontend's host port (`next-frontend/compose.yaml` maps `3001:3000`). Rationale: implementation finding in phase-03 SI-03.1; the CORS requirements above are unchanged, only where they are configured.

### phase-03-videos/TD-05

**Recommendation:** it isolates CPU-heavy work from the API as the capability requires while keeping a single source of truth for the `videos` schema and a single Definition-of-Done pipeline. (Source option: same codebase, `createApplicationContext` entrypoint, dedicated `video-worker` container with ffmpeg, using `execFile` over presigned internal URLs.)
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** with presigned multipart the API must call `CompleteMultipartUpload` anyway, so it is the natural point to validate size and enqueue; it keeps the trigger inside tested application code and storage-vendor-neutral, and the crash window is covered by `jobId` dedup + the TD-11 reconciler.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** it satisfies "short and never conflicting" with the DB as the uniqueness authority, stays stable across Fase 04 title edits, and is unguessable for Fase 05 unlisted links. (Source option: 11-char base62 `public_id` with unique constraint + retry, UUID kept as PK.)
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** storage already implements Range/206 so streaming works without bytes touching Node, while the API keeps control over who may watch; TTL is an env key (`PRESIGNED_GET_TTL_SECONDS`) sized for long videos. Note: no transcoding/HLS in this phase — progressive MP4 playback starts fastest when the `moov` atom is at the front; files without it still play via Range seek. (Source option: authorize in API, `302` to presigned GET; download via signed `response-content-disposition: attachment`.)
**Libraries:** —

**Revisions:**
- 2026-10-18 — Fixes the Phase 03 access rule: `/stream` and `/download` are authenticated and owner-only (the video's owning user), and only when `processing_status=ready`; any other caller gets the standard not-found/forbidden envelope. Phase 04 opens access when a video is published (visibility rules). The frontend player and download button are deferred (contract only in this phase). Rationale: resolves phase-03 validation AMB-1 — no publication flow exists before Phase 04, so every video is still pre-publication.

### phase-03-videos/TD-09

**Recommendation:** it satisfies "pré-cadastro como rascunho" literally while giving the worker a state machine it owns, and avoids a breaking schema change when Fase 04 introduces publication and visibility. (Source option: separate `processing_status` and editorial `status=draft`.)
**Libraries:** —

**Revisions:**
- 2026-10-18 — Clarifies that "rascunho" in the pre-registration capability is the editorial `status=draft`, a field separate from `processing_status`. Minimum data captured at pre-registration (initiate): owner/channel, original filename, declared size and mime type; `title` defaults to the original filename without extension (editable in Phase 04). Rationale: resolves phase-03 validation AMB-2 — the capability did not say which axis "rascunho" belongs to nor which fields are required at initiate.

### phase-03-videos/TD-10

**Recommendation:** it uses the queue features chosen in TD-01 and relies on the TD-09 state machine for correctness, so duplicates and retries are harmless. (Source option: BullMQ `attempts`/exponential backoff + `UnrecoverableError` for invalid media + idempotent, conditional writes keyed by `videoId`.)
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** it is the only option that keeps the `videos` table consistent with storage and recovers stuck jobs, reusing the queue scheduler from TD-01 instead of adding `@nestjs/schedule`. (Source option: scheduled reconciler in the worker + storage-level expiry as backstop.)
**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** it keeps video access fully mediated by the API while giving listings cheap, cacheable thumbnail URLs, and the UUID key prevents enumeration. (Source option: private `videos` bucket + anonymous-read `thumbnails` bucket, keys by `videoId` UUID.)
**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** it matches the project's existing real-service testing pattern (`db`, `mailpit`) and is the only option that verifies the multipart/presign/Range contracts this phase depends on; the testing-guide skill's storage section should be updated accordingly as part of implementation. (Source option: real MinIO + Redis + ffmpeg via Compose, isolated by test buckets and BullMQ prefix.)
**Libraries:** —

**Revisions:**
- 2026-10-18 — The official `minio/minio` and `minio/mc` images are no longer published on Docker Hub or Quay. With the user's approval, Compose uses the drop-in community fork, pinned to exact tags: `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` for the `minio` service and `pgsty/mc:RELEASE.2026-10-18T00-00-00Z` for the one-shot provisioning service, implemented as `minio-init` (named `createbuckets` in TD-12). The real-services strategy is unchanged. Rationale: implementation finding in phase-03 SI-03.1; it applies the "pin an exact MinIO image tag" mitigation in Notes and Risks.

### phase-03-videos/TD-14

**Recommendation:** Option C (declared allowlist at initiate for a cheap `400` + ffprobe in the worker as source of truth, invalid media → `UnrecoverableError` → `processing_status=failed` with a typed `processing_error`, original object deleted immediately with TD-11's reconciler as backstop). The pre-check gives the deferred frontend an early, actionable error without bytes touching the API. ffprobe stays the only check that sees real content and codecs, which matters because there is no transcoding to rescue an unplayable file. The failure path reuses the TD-09 state machine and TD-10 retry semantics, only adding the parse-vs-I/O distinction. Option D's extra sniff duplicates part of what ffprobe already proves seconds later.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema,... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule`... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| "Reprodução via streaming (sem necessidade de download completo)" / "Download do vídeo pelo usuário" — FE player and download button | deferred | deferred_to_next_phase — Phase 03 ships only the API contract (`/stream`, `/download`, owner-only while `processing_status=ready`, per AMB-1); the player and download UI land in a later phase. | phase-03-videos/TD-08 |
| "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" — FE upload UI (part-by-part PUTs, resume, progress) | deferred | deferred_to_next_phase — Phase 03 ships only the multipart upload handshake endpoints documented in `openapi.json`; the upload UI lands in a later phase. | phase-03-videos/TD-02 |

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
| BullMQ processor (`@Processor`) | Unit: dispatch + `failed`-event decision; Integration: real Postgres + Redis + MinIO job outcome |
| Service running an external binary (ffprobe/ffmpeg) | Integration: real binary on `test/fixtures/media/` fixtures (+ Unit for any branching around it) |

_The video worker lives in `nestjs-project` (`src/worker/`, per `phase-03-videos/TD-05`), so the two rows above cover it._
