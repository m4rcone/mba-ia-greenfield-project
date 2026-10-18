---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-18T02:52:17-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-18T02:49:34-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-18T02:50:15-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Streaming/download: who may access a video before Phase 04 publish flow"
    resolved_by: phase-03-videos/TD-08
  - id: AMB-2
    status: resolved
    summary: "'Rascunho' at pre-registration: processing state vs Phase 04 publish state"
    resolved_by: phase-03-videos/TD-09
  - id: AMB-3
    status: resolved
    summary: "'Sem impacto na performance' has no measurable acceptance criterion"
    resolved_by: phase-03-videos/TD-02
  - id: MD-1
    status: resolved
    summary: "No TD decides accepted video formats / upload content validation"
    resolved_by: phase-03-videos/TD-14
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Queue Technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Large Upload Protocol (≤10GB direct to storage)"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — S3 Client Library"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — MinIO internal vs public endpoint for presigned URLs"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Video Worker Runtime and FFmpeg Integration"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Processing Trigger"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Unique Video URL Strategy (public ID shape)"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Video Status Model"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Job Retry, Backoff and Idempotency Policy"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Abandoned Multipart Uploads and Stuck Videos Cleanup"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Bucket and Object Key Organization"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Test Strategy for Storage, Queue and FFmpeg"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-14
    status: resolved
    summary: "TD-14 pending — Accepted Video Formats and Upload Content-Validation"
    resolved_by: phase-03-videos/TD-14
  - id: DG-1
    status: resolved
    summary: "Video ownership FK target (user vs channel) not confirmed by a prior-phase deliverable"
    resolved_by: clarification
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._ _(Every capability bullet maps to ≥1 decided TD in `## Capability Coverage`. The error-response format for `nestjs-project` is inherited from `phase-02-auth/TD-07`. The shared-types contract-sync check (Decisão #29) does not apply because there is no `## UI Inventory` (UI not in scope; FE surfaces are listed in `## Non-UI / Deferred Capabilities`).)_

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._ _(Decided current-phase TDs are consistent with inherited conventions: new env keys (TD-01 Redis, TD-04 S3, TD-08 TTL) follow the `registerAs` + Joi pattern; TD-13's real-MinIO integration tests satisfy the "real capture service or local adapter" requirement for storage side-effect services; owner-only stream/download (TD-08 revision) reuses phase-02-auth/TD-02 guards. The 2026-10-18 implementation revisions keep every decided option: TD-01 pins `@nestjs/bullmq ^11.0.5` and adds `ioredis` as a direct dependency, TD-04 moves CORS to the `minio` service config, TD-13 pins the `pgsty` MinIO images.)_

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(context.md has no `## UI Inventory`, so UI is not in scope for this phase and the check does not apply.)_

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-14)_ — No TD decided accepted video formats or upload content validation. TD-14 "Accepted Video Formats and Upload Content-Validation Strategy" now covers it (decided: C — declared allowlist at initiate + ffprobe in the worker; see OQ-14).
- **AMB-1** _(resolved_by phase-03-videos/TD-08)_ — Phase 03 streaming/download is authenticated and owner-only, allowed only when `processing_status=ready`; Phase 04 opens access on publish. The FE player/download button is deferred (row added to `## Non-UI / Deferred Capabilities` in context.md). Recorded as a Revisions entry on TD-08.
- **AMB-2** _(resolved_by phase-03-videos/TD-09)_ — "Rascunho" is the editorial `status=draft`, separate from `processing_status`. Pre-registration captures owner/channel, original filename, declared size and mime type; `title` defaults to the filename without extension. Recorded as a Revisions entry on TD-09.
- **AMB-3** _(resolved_by phase-03-videos/TD-02)_ — "Sem impacto na performance" means the API never receives or buffers video bytes and API memory stays flat during upload; no concurrency target this phase. Recorded as a Revisions entry on TD-02.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 Queue Technology decided: A (BullMQ + Redis).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 Large Upload Protocol (≤10GB direct to storage) decided: B (S3 multipart, presigned URL per part).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 S3 Client Library decided: A (AWS SDK v3).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 MinIO Internal vs Public Endpoint for Presigned URLs decided: A (two S3 clients: internal I/O + public presign).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 Video Worker Runtime and FFmpeg Integration decided: A (same codebase, separate `video-worker` container).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 Processing Trigger decided: A ("complete upload" endpoint enqueues).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 Unique Video URL Strategy (public ID shape) decided: B (11-char base62 `public_id`).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 Streaming and Download Delivery decided: A (API authorizes, `302` to presigned GET).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 Video Status Model decided: B (`processing_status` + editorial `status`).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 Job Retry, Backoff and Idempotency Policy decided: A (BullMQ retries + idempotent processor).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 Abandoned Multipart Uploads and Stuck Videos Cleanup decided: B (reconciler + storage expiry backstop).
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 Bucket and Object Key Organization decided: B (private `videos` + anonymous-read `thumbnails`).
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — TD-13 Test Strategy for Storage, Queue and FFmpeg decided: A (real MinIO + Redis + ffmpeg in Compose).
- **OQ-14** _(resolved_by phase-03-videos/TD-14)_ — TD-14 Accepted Video Formats and Upload Content-Validation Strategy decided: C (declared allowlist + ffprobe in worker).
- **DG-1** _(resolved_by clarification)_ — Video ownership FK target. `videos.channel_id` → `channels.id` uses the `channels` entity delivered by Phase 02 (`nestjs-project/src/channels/entities/channel.entity.ts`: 1:1 with `users` via unique `user_id`, created at signup). Owner-only authorization (TD-08 revision) resolves the channel via `channel.user_id === authenticated user id`. TD-09's "owner/channel" pre-registration data means `channel_id`. No TD edit.
