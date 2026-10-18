---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-18T00:31:59-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-18T00:31:53-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-18T00:18:37-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-17T22:46:49-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o serviço de armazenamento de arquivos (vídeos e thumbnails) e o serviço de processamento em segundo plano (filas) para que o upload de vídeos de até 10GB funcione sem impacto na performance, com pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático após o upload (extração de duração e metadados), geração automática de thumbnail, URL única por vídeo, reprodução via streaming e download do vídeo pelo usuário.

---

## Step Implementations

### SI-03.1 — Infra: dependências e serviços Compose (MinIO, Redis, buckets)

**Description:** Instalar as bibliotecas de fila e S3 e subir os serviços reais de armazenamento e fila no Compose, com os buckets `videos` (privado) e `thumbnails` (leitura anônima) provisionados automaticamente — base de infraestrutura de toda a fase.

**Technical actions:**

1. Instalar em `nestjs-project`: `bullmq@^6.x`, `@nestjs/bullmq@^12.x`, `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`); conferir a versão instalada contra `library-refs.md` e sinalizar divergência de major
2. Adicionar o serviço `redis` em `nestjs-project/compose.yaml` com `maxmemory-policy noeviction` e healthcheck; `nestjs-api` passa a depender dele (per `phase-03-videos/TD-01`)
3. Adicionar o serviço `minio` em `compose.yaml` com `MINIO_API_STALE_UPLOADS_EXPIRY` configurado como backstop de multipart abandonado e healthcheck (per `phase-03-videos/TD-11`, `phase-03-videos/TD-13`)
4. Adicionar o serviço one-shot `minio-init` (`mc`) que cria os buckets `videos` (privado) e `thumbnails` (anonymous read), e aplica a CORS do storage permitindo a origem do frontend com `GET, PUT, HEAD` e expondo `ETag` (per `phase-03-videos/TD-12`, `phase-03-videos/TD-04`, `phase-03-videos/TD-02`)
5. Garantir que todos os hosts usem nomes de serviço do Compose (`redis`, `minio`) — nunca `localhost` (per root `CLAUDE.md` § Docker Networking)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up` sobe `redis`, `minio` e `minio-init` saudáveis; `minio-init` termina com exit code 0
- `redis-cli CONFIG GET maxmemory-policy` dentro do container `redis` retorna `noeviction`
- Bucket `videos` recusa `GET` anônimo de um objeto (`403`); bucket `thumbnails` serve `GET` anônimo de um objeto (`200`)
- Requisição preflight `OPTIONS` ao bucket `videos` com a origem do frontend retorna os métodos `GET, PUT, HEAD` permitidos e `ETag` em `Access-Control-Expose-Headers`
- Suíte de testes existente continua passando com os novos serviços no ar

---

### SI-03.2 — Infra: namespaces de configuração storage, redis e upload

**Description:** Criar os namespaces `registerAs` de storage, redis e upload com validação Joi, para que API e worker leiam endpoints, credenciais, buckets e limites de uma única fonte tipada.

**Technical actions:**

1. Criar `src/config/storage.config.ts` — `registerAs('storage', …)` lendo `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE`, `S3_BUCKET_VIDEOS` (default `videos`), `S3_BUCKET_THUMBNAILS` (default `thumbnails`), `PRESIGNED_GET_TTL_SECONDS` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-08`, `phase-03-videos/TD-12`; convenção `phase-01-configuracao-base/TD-03`)
2. Criar `src/config/redis.config.ts` — `registerAs('redis', …)` lendo `REDIS_HOST` (default `redis`) e `REDIS_PORT` (default `6379`) (per `phase-03-videos/TD-01`)
3. Criar `src/config/upload.config.ts` — `registerAs('upload', …)` lendo `UPLOAD_MAX_SIZE_BYTES` (default `10737418240`), `UPLOAD_PART_SIZE_BYTES` (default 16 MiB), `UPLOAD_ABANDON_AFTER_HOURS`, `PROCESSING_STUCK_AFTER_MINUTES` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-11`)
4. Estender `src/config/env.validation.ts` com todas as chaves acima (credenciais S3 obrigatórias, demais com default) e registrar os três factories no `load` do `ConfigModule.forRoot` em `AppModule` (per `phase-01-configuracao-base/TD-02`)
5. Atualizar `.env.example` e o bloco `environment` do `nestjs-api` em `compose.yaml` com valores compatíveis com o Compose (`S3_ENDPOINT=http://minio:9000`, `REDIS_HOST=redis`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: novas chaves obrigatórias rejeitadas quando ausentes, defaults aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1 — os valores default apontam para os serviços `minio` e `redis` criados ali

**Acceptance criteria:**

- A aplicação sobe sem erros com todas as novas variáveis presentes; `GET /` continua retornando `200`
- Subir a aplicação sem `S3_ACCESS_KEY` falha no bootstrap com erro de validação Joi
- Sem `UPLOAD_MAX_SIZE_BYTES` definido, o namespace `upload` expõe `10737418240`
- Sem `REDIS_HOST` definido, o namespace `redis` expõe `redis` (nome de serviço do Compose)

---

### SI-03.3 — StorageModule com clientes S3 interno e público

**Description:** Encapsular todo acesso ao object storage em um `StorageService` com dois `S3Client` — interno para I/O e público apenas para assinar URLs — entregando o "serviço de armazenamento de arquivos (vídeos e thumbnails)".

**Technical actions:**

1. Criar `src/storage/storage.module.ts` — providers `S3_INTERNAL_CLIENT` (endpoint `S3_ENDPOINT`) e `S3_PUBLIC_CLIENT` (endpoint `S3_PUBLIC_ENDPOINT`) via factory com `storageConfig.KEY`, ambos com `forcePathStyle`, `requestChecksumCalculation: 'WHEN_REQUIRED'` e `responseChecksumValidation: 'WHEN_REQUIRED'`; exporta `StorageService` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)
2. Criar `src/storage/storage.service.ts` — operações multipart via cliente interno: `createMultipartUpload`, `listParts` (paginação até `IsTruncated=false`), `completeMultipartUpload`, `abortMultipartUpload` (per `phase-03-videos/TD-02`)
3. Adicionar ao `StorageService` operações de objeto via cliente interno: `headObject` (retorna `ContentLength` ou `null`), `deleteObject`, `deletePrefix`, `putObject` (per `phase-03-videos/TD-12`, `phase-03-videos/TD-14`)
4. Adicionar ao `StorageService` os presigners: `presignUploadPart` e `presignGet` (com `ResponseContentType` / `ResponseContentDisposition` opcionais) via cliente **público**; `presignInternalGet` via cliente interno para o worker; `getPublicObjectUrl(bucket, key)` path-style sobre `S3_PUBLIC_ENDPOINT` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-08`)
5. Criar `src/test/minio.ts` — helper de teste que cria/esvazia buckets de teste isolados (per `phase-03-videos/TD-13`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: MinIO real — ciclo multipart completo, `listParts` paginado, head/delete/put, URL presignada de part aceita `PUT` e devolve `ETag`, URL presignada de GET responde `206` a `Range` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test com os dois clientes resolvidos | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.2 — consome `storageConfig`

**Acceptance criteria:**

- Um objeto enviado em 2 partes via URLs presignadas de `UploadPart` e concluído com `completeMultipartUpload` existe no bucket com `ContentLength` igual à soma das partes
- URLs presignadas emitidas pelo `StorageService` têm host igual a `S3_PUBLIC_ENDPOINT` e não contêm parâmetros de checksum CRC32
- `GET` em uma URL presignada de leitura com `Range: bytes=0-99` retorna `206` com `Content-Range`
- URL presignada com `ResponseContentDisposition: attachment` devolve `Content-Disposition: attachment` na resposta do storage
- `abortMultipartUpload` faz `listParts` subsequente falhar com `NoSuchUpload`

---

### SI-03.4 — Entidade Video e migration CreateVideos

**Description:** Criar a entidade `Video` com os eixos ortogonais `status` (editorial) e `processing_status` (pipeline) e a migration correspondente, base de persistência do pré-cadastro, do processamento e da URL única.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com os campos exatos de `### Data Model → Video` (`id` uuid PK, `public_id` varchar(11) unique, `channel_id` FK, `title`, `status` enum `video_status` default `draft`, `processing_status` enum `video_processing_status` default `uploading`, `processing_error`, `original_filename`, `content_type`, `size_bytes` bigint, `upload_id`, `part_size`, `part_count`, `duration_seconds` numeric(12,3), `width`, `height`, `video_codec`, `audio_codec`, `thumbnail_key`, `created_at`, `updated_at`) (per `phase-03-videos/TD-07`, `phase-03-videos/TD-09`)
2. Declarar `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })` e `onDelete: 'CASCADE'`; sem relação inversa em `User`; índices btree em `channel_id` e `(processing_status, updated_at)` (per `phase-03-videos/TD-11`)
3. Criar a migration `src/database/migrations/<timestamp>-CreateVideos.ts` — cria os dois enums, a tabela, FK e índices; `down` remove na ordem inversa — e registrá-la em `src/database/migrations.integration-spec.ts`
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrar `VideosModule` em `AppModule`; incluir `DELETE FROM "videos"` em `cleanAllTables` (`src/test/create-test-data-source.ts`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique `public_id`, defaults `status=draft` / `processing_status=uploading`, `size_bytes` > 2^31 persiste sem perda, cascade ao remover o canal | `src/videos/entities/video.entity.integration-spec.ts` |
| `CreateVideos` migration | Integration: apply/revert bidirecional | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none _(depende apenas de `Channel`, entregue na Fase 02)_

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos`, os enums `video_status` e `video_processing_status`, a FK para `channels` e os três índices; `migration:revert` remove tudo
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade
- Um vídeo inserido sem `status`/`processing_status` persiste com `draft` / `uploading`
- `size_bytes = 10737418240` é lido de volta com o mesmo valor
- Remover o canal remove os vídeos dele

---

### SI-03.5 — Allowlist de formatos e gerador de public ID

**Description:** Criar as duas regras puras compartilhadas da fase — a allowlist de formatos (usada pelo initiate e pelo worker) e o gerador de ID base62 de 11 caracteres que garante a URL única por vídeo.

**Technical actions:**

1. Criar `src/videos/video-formats.ts` — tabela de `### Data Model → Shared constant` (extensão → `contentType`, `format_name`, codecs de vídeo e áudio por container) + `resolveContentTypeFromFileName(fileName)` (case-insensitive) e `isDeclaredFormatAllowed(fileName, contentType)` (per `phase-03-videos/TD-14`)
2. Adicionar a `video-formats.ts` o validador de resultado de probe `validateProbe(probe)` → `{ ok: true, metadata } | { ok: false, error: 'NOT_A_VIDEO' | 'UNSUPPORTED_CONTAINER' | 'UNSUPPORTED_CODEC' | 'CORRUPT_MEDIA' }`, aplicando as checagens estruturais (≥1 stream de vídeo sem `attached_pic`, `duration` finita > 0, `width`/`height` > 0) (per `phase-03-videos/TD-14`)
3. Criar `src/videos/public-id.util.ts` — `generatePublicId()` com 11 caracteres base62 a partir de `crypto.randomBytes` (rejection sampling, sem viés de módulo) (per `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `video-formats.ts` | Unit: matriz extensão × contentType, codecs por container, cada ramo de erro de `validateProbe` | `src/videos/video-formats.spec.ts` |
| `public-id.util.ts` | Unit: comprimento 11, alfabeto `^[0-9A-Za-z]{11}$`, ausência de colisão em amostra grande | `src/videos/public-id.util.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `isDeclaredFormatAllowed('clip.MOV', 'video/quicktime')` é verdadeiro; `('clip.mov', 'video/mp4')` e `('clip.avi', 'video/x-msvideo')` são falsos
- Um probe de `.webm` com codec de vídeo `h264` é rejeitado com `UNSUPPORTED_CODEC`
- Um probe cujo único stream de vídeo tem `disposition.attached_pic=1` é rejeitado com `NOT_A_VIDEO`
- Um probe com `format.duration` ausente ou `0` é rejeitado com `CORRUPT_MEDIA`
- Todo ID gerado casa `^[0-9A-Za-z]{11}$`

---

### SI-03.6 — QueueModule e VideoProcessingProducer

**Description:** Registrar a conexão BullMQ e a fila `video-processing` em um módulo compartilhado entre API e worker, e entregar o producer que enfileira `process-video` com deduplicação por `jobId` — o "serviço de processamento em segundo plano (filas)".

**Technical actions:**

1. Criar `src/queue/queue.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, nomes de job `process-video` / `cleanup-stale-uploads` e o tipo `ProcessVideoJobData = { videoId: string }` (per `### Events/Messages`)
2. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` com `inject: [redisConfig.KEY]` e chave `connection` (não `redis`, conforme a divergência sinalizada em `library-refs.md`) + `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; exporta `BullModule` e o producer; prefixo BullMQ parametrizável para isolamento em teste (per `phase-03-videos/TD-01`, `phase-03-videos/TD-13`)
3. Criar `src/queue/video-processing.producer.ts` — `enqueueProcessVideo(videoId)` com `jobId = videoId`, `attempts: 3`, `backoff: { type: 'exponential', delay: 10_000 }`, `removeOnComplete` / `removeOnFail` com `age` de retenção (per `phase-03-videos/TD-06`, `phase-03-videos/TD-10`)
4. Criar `src/test/redis.ts` — helper que cria a fila com prefixo de teste e faz `obliterate({ force: true })` entre specs (per `phase-03-videos/TD-13`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration: Redis real — job criado com `jobId = videoId`, opções de retry, segundo enqueue com o mesmo id não duplica | `src/queue/video-processing.producer.integration-spec.ts` |
| `QueueModule` | Unit: compilation test com `getQueueToken('video-processing')` resolvido | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.2 — consome `redisConfig`

**Acceptance criteria:**

- `enqueueProcessVideo(id)` cria na fila `video-processing` um job `process-video` com `id === videoId`, payload `{ videoId }` e `attempts = 3`
- Chamar `enqueueProcessVideo(id)` duas vezes com o mesmo id deixa exatamente um job na fila
- O módulo da API não registra nenhum `@Processor`: um job enfileirado pela API permanece em `waiting` enquanto o worker não está rodando

---

### SI-03.7 — VideosService: pré-cadastro e ciclo de vida do upload multipart

**Description:** Implementar as regras de negócio do upload — pré-cadastro como rascunho ao iniciar, URLs de parts, retomada, conclusão com checagem de tamanho e enfileiramento, e cancelamento — com autorização owner-only resolvida pelo canal do usuário.

**Technical actions:**

1. Criar `src/videos/exceptions/video.exceptions.ts` — subclasses de `DomainException` para `UNSUPPORTED_VIDEO_FORMAT` (400), `INVALID_PART_NUMBER` (400), `UPLOAD_SIZE_MISMATCH` (400), `VIDEO_NOT_FOUND` (404), `UPLOAD_NOT_IN_PROGRESS` (409), `UPLOAD_INCOMPLETE` (409), `VIDEO_NOT_READY` (409) exatamente como em `### Error Catalog` (per `phase-02-auth/TD-07`)
2. Adicionar `ChannelsService.findByUserId(userId)` em `ChannelsModule` (dono da entidade `Channel`) e exportar `ChannelsService`; `VideosModule` importa `ChannelsModule`, `StorageModule` e `QueueModule`. `VideosService.findOwnedOrFail(videoId, userId)` faz join `videos.channel_id → channels.user_id` e lança `VIDEO_NOT_FOUND` quando não é dono
3. Criar `VideosService.initiateUpload(userId, dto)` em `src/videos/videos.service.ts` — valida allowlist via `video-formats.ts` (`UNSUPPORTED_VIDEO_FORMAT`), calcula `partSize = max(UPLOAD_PART_SIZE_BYTES, ceil(fileSize/10_000))` arredondado para MiB e `partCount`, gera o `id` UUID na aplicação, `createMultipartUpload` em `videos/{videoId}/original`, um único `INSERT` com `upload_id`/`part_size`/`part_count`, `title` = `fileName` sem extensão, retry do `INSERT` com novo `public_id` em unique-violation; falha definitiva do `INSERT` → `abortMultipartUpload` antes de propagar (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`, `phase-03-videos/TD-09`, `phase-03-videos/TD-14`)
4. Criar `presignParts(videoId, userId, partNumbers)` (`UPLOAD_NOT_IN_PROGRESS`, `INVALID_PART_NUMBER`, `expiresIn` 900) e `listUploadedParts(videoId, userId)` (paginado via `StorageService.listParts`) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`)
5. Criar `completeUpload(videoId, userId)` — `listParts` → `UPLOAD_INCOMPLETE` se partes ≠ `1..partCount` → `completeMultipartUpload` com lista montada no servidor → `headObject`; divergência de tamanho → `deleteObject` + `failed`/`UPLOAD_SIZE_MISMATCH` + `UPLOAD_SIZE_MISMATCH`; sucesso → update condicional `uploading→processing`, `upload_id=NULL` → `VideoProcessingProducer.enqueueProcessVideo` — e `cancelUpload(videoId, userId)` — `abortMultipartUpload` + `failed`/`UPLOAD_CANCELLED`, `upload_id=NULL` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`, `phase-03-videos/TD-09`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: ramos de allowlist, cálculo de `partSize`/`partCount` (incl. guarda `ceil(size/10000)`), retry de `public_id`, abort em falha de INSERT, transições inválidas (mock repo/storage/producer) | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: Postgres + MinIO + Redis reais — initiate → parts → complete enfileira job; size mismatch marca `failed`; cancel; não-dono recebe `VIDEO_NOT_FOUND` | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário, `null` quando inexistente | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.3 (StorageService), SI-03.4 (entidade `Video`), SI-03.5 (allowlist e public ID), SI-03.6 (producer)

**Acceptance criteria:**

- `initiateUpload` com `fileSize = 10737418240` persiste `part_size = 16777216`, `part_count = 640`, `status=draft`, `processing_status=uploading` e um `upload_id` válido no storage
- Falha simulada de `CreateMultipartUpload` não deixa nenhuma linha em `videos`
- `completeUpload` com todas as partes cobertas deixa o vídeo em `processing`, `upload_id = NULL` e um job `process-video` com `jobId = videoId` na fila
- `completeUpload` com tamanho armazenado diferente do declarado remove o objeto e deixa o vídeo em `failed` com `processing_error = UPLOAD_SIZE_MISMATCH`
- `completeUpload` com uma parte faltando lança `UPLOAD_INCOMPLETE` e mantém o vídeo em `uploading`
- `cancelUpload` aborta o multipart e deixa o vídeo em `failed` com `processing_error = UPLOAD_CANCELLED`
- Qualquer operação sobre vídeo de outro usuário lança `VIDEO_NOT_FOUND`

---

### SI-03.8 — Endpoints de upload multipart (initiate, parts, complete, cancel)

**Route:** POST /videos, POST /videos/:id/upload/parts, GET /videos/:id/upload/parts, POST /videos/:id/upload/complete, DELETE /videos/:id/upload
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`
**Authorization:** Authenticated (POST /videos); Owner (demais rotas) — per `### Authorization Matrix`

**Description:** Expor o handshake de upload multipart via REST, documentado no `openapi.json` para o frontend adiado, sem que bytes de vídeo passem pela API.

**Technical actions:**

1. Criar `src/videos/dto/initiate-upload.dto.ts` (`fileName`, `contentType`, `fileSize`) e `src/videos/dto/presign-parts.dto.ts` (`partNumbers`: 1–100 inteiros únicos ≥ 1) conforme `### API Contracts → Validation Rules — Upload initiate` (per `phase-02-auth/TD-06`); e DTOs de resposta `InitiateUploadResponseDto`, `PresignPartsResponseDto`, `UploadedPartsResponseDto`, `CompleteUploadResponseDto` com os campos exatos de `### API Contracts`
2. Criar `src/videos/videos.controller.ts` — as cinco rotas delegando ao `VideosService`, `@CurrentUser()` para o `sub`, `ParseUUIDPipe` em `:id` (→ `VALIDATION_ERROR`), status `201` / `200` / `200` / `202` / `204`; registrar o controller em `VideosModule`
3. Anotar cada rota com `@ApiOperation`, `@ApiBearerAuth`, `@ApiBody` e `@ApiResponse` por status, incluindo os erros de `### Error Catalog` com o envelope `ApiErrorEnvelopeDto` (per `openapi-docs-nestjs/TD-01` revision)
4. Regenerar e commitar `openapi.json` via `npm run openapi:export` (per `openapi-docs-nestjs/TD-02`)
5. Não adicionar parser de corpo binário/multipart (`Multer`, `raw`) nem aumentar o limite do body JSON — a API recebe apenas metadados (per `phase-03-videos/TD-02` revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` | Unit: compilation test (TypeORM feature, Channels, Storage, Queue) | `src/videos/videos.module.spec.ts` |

_Os cenários HTTP (E2E) deste controller são autorizados externamente no spec referenciado em `**Test Specs:**`._

**Dependencies:** SI-03.7 — o controller delega ao `VideosService`

**Acceptance criteria:**

- `POST /videos` com `{ fileName: "clip.mp4", contentType: "video/mp4", fileSize: 10737418240 }` retorna `201` com `status: "draft"`, `processing_status: "uploading"`, `partSize: 16777216`, `partCount: 640` e `public_id` de 11 caracteres
- `POST /videos` com `fileName: "clip.avi"` retorna `400` com `error: "UNSUPPORTED_VIDEO_FORMAT"`; com `fileSize: 0` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos/:id/upload/parts` com `partNumbers: [1, 2]` retorna `200` com duas URLs cujo host é `S3_PUBLIC_ENDPOINT`; com número maior que `partCount` retorna `400` `INVALID_PART_NUMBER`
- `GET /videos/:id/upload/parts` após o upload da parte 1 retorna `uploadedParts` contendo `{ partNumber: 1 }`
- `POST /videos/:id/upload/complete` com todas as partes enviadas retorna `202` com `processing_status: "processing"`; repetido retorna `409` `UPLOAD_NOT_IN_PROGRESS`
- `DELETE /videos/:id/upload` retorna `204`; chamado por outro usuário retorna `404` `VIDEO_NOT_FOUND`
- Qualquer rota sem token retorna `401`
- Durante um upload completo de arquivo grande, a API não recebe bytes de vídeo e seu uso de memória permanece estável independentemente do tamanho do arquivo
- `openapi.json` commitado contém as cinco operações com seus códigos de erro

---

### SI-03.9 — Endpoints de consulta, streaming e download

**Route:** GET /videos/:id, GET /videos/:publicId/stream, GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** Owner — stream/download somente com `processing_status=ready` (per `### Authorization Matrix`)

**Description:** Permitir ao dono acompanhar o processamento e os metadados extraídos (incluindo a thumbnail) e assistir/baixar o vídeo via redirect para URL presignada, com o storage atendendo `Range`/`206` sem bytes passarem pelo Node.

**Technical actions:**

1. Adicionar `VideosService.getOwnedVideo(videoId, userId)` — retorna o `VideoResponseDto` de `### API Contracts → GET /videos/:id`, com `thumbnail_url` montado por `StorageService.getPublicObjectUrl(S3_BUCKET_THUMBNAILS, thumbnail_key)` e `null` enquanto `processing_status ≠ ready` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-12`, `phase-03-videos/TD-04`)
2. Adicionar `VideosService.getPlaybackUrl(publicId, userId, mode: 'stream' | 'download')` — `publicId` fora de `^[0-9A-Za-z]{11}$` ou vídeo de outro dono → `VIDEO_NOT_FOUND`; `processing_status ≠ ready` → `VIDEO_NOT_READY`; `presignGet` com `ResponseContentType` = `content_type`, `expiresIn = PRESIGNED_GET_TTL_SECONDS` e, em `download`, `ResponseContentDisposition: attachment; filename*=UTF-8''<original_filename percent-encoded>` (per `phase-03-videos/TD-08` + revision)
3. Adicionar ao `VideosController` as três rotas — `GET /videos/:id` com `ParseUUIDPipe`; `/stream` e `/download` respondendo `302` com `Location` = URL presignada e `Cache-Control: no-store`
4. Anotar as rotas com `@ApiOperation` / `@ApiResponse` (incluindo `302` e os erros `VIDEO_NOT_FOUND` / `VIDEO_NOT_READY`) e regenerar `openapi.json` via `npm run openapi:export` (per `openapi-docs-nestjs/TD-01` revision, `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (consulta/playback) | Unit: `publicId` malformado, não-dono, não-`ready`, disposição de download com nome UTF-8, `thumbnail_url` nulo antes de `ready` | `src/videos/videos.service.spec.ts` |
| `VideosService` (consulta/playback) | Integration: Postgres + MinIO reais — URL de stream responde `206` a `Range`; URL de download responde `Content-Disposition: attachment` | `src/videos/videos.service.integration-spec.ts` |

_Os cenários HTTP (E2E) deste controller são autorizados externamente no spec referenciado em `**Test Specs:**`._

**Dependencies:** SI-03.8 — estende o `VideosController` e o `openapi.json` criados ali

**Acceptance criteria:**

- `GET /videos/:id` pelo dono retorna `200` com `processing_status` corrente e `thumbnail_url: null` enquanto o vídeo não está `ready`
- `GET /videos/:id` de um vídeo `ready` retorna `duration_seconds`, `width`, `height`, `video_codec` e um `thumbnail_url` que responde `200` a `GET` anônimo
- `GET /videos/:publicId/stream` pelo dono de um vídeo `ready` retorna `302` com `Cache-Control: no-store`; seguir o `Location` com `Range: bytes=0-1023` retorna `206` com `Content-Range`
- `GET /videos/:publicId/download` retorna `302`; seguir o `Location` retorna `Content-Disposition: attachment` com o nome original do arquivo
- `/stream` ou `/download` de um vídeo em `processing` retorna `409` `VIDEO_NOT_READY`
- `/stream` com `publicId` malformado, inexistente ou de outro usuário retorna `404` `VIDEO_NOT_FOUND`
- Qualquer rota sem token retorna `401`

---

### SI-03.10 — Infra: runtime do Video Worker (entrypoint, módulo e container com FFmpeg)

**Description:** Criar o processo worker no mesmo codebase, com entrypoint próprio em contexto standalone do NestJS e container dedicado com ffmpeg, isolando o trabalho pesado de CPU da API.

**Technical actions:**

1. Criar `src/worker/main.ts` — `NestFactory.createApplicationContext(WorkerModule)` com `enableShutdownHooks()` para fechar o worker BullMQ graciosamente (per `phase-03-videos/TD-05`)
2. Criar `src/worker/worker.module.ts` — `ConfigModule.forRoot` com os mesmos factories e `envValidationSchema`, `TypeOrmModule.forRootAsync` (mesmo `databaseConfig`, entidade `Video`), `StorageModule` e `QueueModule`; é o **único** módulo onde providers `@Processor` serão registrados (per `phase-03-videos/TD-05`, `phase-03-videos/TD-01`; convenção `phase-01-configuracao-base/TD-01`)
3. Instalar `ffmpeg` (inclui `ffprobe`) na imagem de desenvolvimento usada pelo `video-worker` e pelo container onde os testes rodam (`Dockerfile.dev`) (per `phase-03-videos/TD-05`, `phase-03-videos/TD-13`)
4. Adicionar o serviço `video-worker` em `compose.yaml` — mesmo build/volume do `nestjs-api`, comando do entrypoint do worker, mesmas variáveis de ambiente, `depends_on` `db`, `redis` e `minio-init`; adicionar scripts `start:worker` / `start:worker:dev` em `package.json`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test (config, TypeORM, Storage, Queue) | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.3 (StorageModule), SI-03.4 (entidade `Video`), SI-03.6 (QueueModule)

**Acceptance criteria:**

- `docker compose up video-worker` inicia o processo sem abrir porta HTTP e permanece em execução
- `ffprobe -version` e `ffmpeg -version` executam com sucesso dentro dos containers `video-worker` e `nestjs-api`
- `docker compose stop video-worker` encerra o processo sem erro (shutdown gracioso)
- `npm run build` gera tanto o entrypoint da API quanto o do worker

---

### SI-03.11 — Serviços de mídia do worker: probe (ffprobe) e thumbnail (ffmpeg)

**Description:** Encapsular as chamadas a ffprobe e ffmpeg em serviços do worker que extraem duração e metadados, validam o conteúdo real contra a allowlist e geram o JPEG de thumbnail a partir de um frame.

**Technical actions:**

1. Criar `src/worker/media/media-probe.service.ts` — `probe(url)` executa `ffprobe` via `execFile` (sem shell) com saída JSON sobre a URL presignada interna; exit code ≠ 0 por erro de parse (`Invalid data found when processing input`, `moov atom not found`) vira `MediaValidationError('CORRUPT_MEDIA')`, erro de I/O vira erro transitório (per `phase-03-videos/TD-05`, `phase-03-videos/TD-14`)
2. Adicionar `MediaProbeService.probeAndValidate(url)` — aplica `validateProbe` de `src/videos/video-formats.ts`; retorna `{ durationSeconds, width, height, videoCodec, audioCodec }` ou lança `MediaValidationError` com o código tipado (`NOT_A_VIDEO`, `UNSUPPORTED_CONTAINER`, `UNSUPPORTED_CODEC`, `CORRUPT_MEDIA`) (per `phase-03-videos/TD-14`)
3. Criar `src/worker/media/thumbnail.service.ts` — `extractFrame(url, durationSeconds)` executa `ffmpeg` via `execFile` extraindo um frame em `min(1s, duration * 0.1)` codificado como JPEG e retorna o `Buffer` (per `### Events/Messages → process-video`)
4. Adicionar fixtures de mídia pequenas em `test/fixtures/media/` (mp4 h264/aac válido, webm vp9/opus válido, mp4 truncado, PNG renomeado para `.mp4`, mkv com codec fora da allowlist) e registrar os serviços em `WorkerModule` (per `phase-03-videos/TD-13`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService` | Integration: ffprobe real sobre fixtures servidas pelo MinIO — metadados corretos e cada código de erro tipado | `src/worker/media/media-probe.service.integration-spec.ts` |
| `ThumbnailService` | Integration: ffmpeg real — gera JPEG válido (magic bytes `FF D8`) para vídeo curto (< 1s) e longo | `src/worker/media/thumbnail.service.integration-spec.ts` |

**Dependencies:** SI-03.5 (`validateProbe`), SI-03.10 (WorkerModule e ffmpeg na imagem)

**Acceptance criteria:**

- O probe do mp4 h264/aac válido retorna `durationSeconds > 0`, `width`/`height` corretos, `videoCodec = "h264"`, `audioCodec = "aac"`
- O probe do PNG renomeado lança `MediaValidationError` com código `NOT_A_VIDEO` ou `CORRUPT_MEDIA` (nunca sucesso)
- O probe do mp4 truncado lança `CORRUPT_MEDIA`; o do arquivo com codec fora da allowlist lança `UNSUPPORTED_CONTAINER` ou `UNSUPPORTED_CODEC`
- Uma URL inacessível produz erro transitório, distinto de `MediaValidationError`
- `extractFrame` de um vídeo de 0,5 s retorna um JPEG válido

---

### SI-03.12 — VideoProcessor: processamento automático e geração de thumbnail

**Description:** Consumir `process-video` no worker de forma idempotente — probe, validação, thumbnail determinística e transição condicional para `ready` — e marcar `failed` com `processing_error` tipado quando a mídia é inválida ou as tentativas se esgotam.

**Technical actions:**

1. Criar `src/worker/processors/video.processor.ts` — `@Processor('video-processing')` estendendo `WorkerHost`, `process(job)` despacha por `job.name` (`process-video` → `VideoProcessingService.process`); registrar apenas em `WorkerModule` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-05`)
2. Criar `src/worker/processors/video-processing.service.ts` — `process(videoId)`: vídeo já `ready` → no-op; `presignInternalGet` do original → `MediaProbeService.probeAndValidate` → `ThumbnailService.extractFrame` → `putObject` em `thumbnails/{videoId}/default.jpg` (`ContentType: image/jpeg`, sobrescrito em re-execução) → `UPDATE … SET processing_status='ready', duration_seconds, width, height, video_codec, audio_codec, thumbnail_key WHERE id=? AND processing_status='processing'` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-12`)
3. Converter `MediaValidationError` em `UnrecoverableError` do BullMQ (sem retry), preservando o código tipado; erros de I/O propagam para o retry com backoff exponencial (per `phase-03-videos/TD-10`, `phase-03-videos/TD-14`)
4. Adicionar `@OnWorkerEvent('failed')` — em falha final (`UnrecoverableError` ou `attemptsMade ≥ attempts`) faz update condicional `WHERE processing_status='processing'` para `failed` com o código de mídia ou `PROCESSING_FAILED`; em falha de mídia remove `videos/{videoId}/original` e o prefixo `thumbnails/{videoId}/`, sem alterar o resultado do job se a remoção falhar (per `phase-03-videos/TD-10`, `phase-03-videos/TD-14`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: no-op quando já `ready`, mapeamento mídia inválida → `UnrecoverableError`, erro de I/O propagado (mock storage/probe/thumbnail/repo) | `src/worker/processors/video-processing.service.spec.ts` |
| `VideoProcessor` | Unit: decisão de falha final vs tentativa intermediária no evento `failed`, código persistido | `src/worker/processors/video.processor.spec.ts` |
| `VideoProcessor` + `VideoProcessingService` | Integration: Postgres + Redis + MinIO + ffmpeg reais — job de fixture válida termina `ready` com thumbnail; fixture inválida termina `failed` com código e original removido | `src/worker/processors/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.11 (serviços de mídia); SI-03.7 (o `completeUpload` produz o job consumido aqui)

**Acceptance criteria:**

- Após `complete` de um mp4 válido, o vídeo transita para `ready` com `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` e `thumbnail_key = thumbnails/{videoId}/default.jpg` preenchidos
- O objeto `thumbnails/{videoId}/default.jpg` existe no bucket `thumbnails` com `Content-Type: image/jpeg`
- Reprocessar o mesmo `videoId` não cria um segundo objeto de thumbnail nem altera um vídeo já `ready`
- Um arquivo não-vídeo termina em `failed` com `processing_error = NOT_A_VIDEO` (ou `CORRUPT_MEDIA`) após uma única tentativa, e o original é removido do bucket `videos`
- Uma falha transitória persistente termina em `failed` com `processing_error = PROCESSING_FAILED` somente após 3 tentativas
- Um vídeo cujo `processing_status` não é `processing` nunca é sobrescrito pelo worker

---

### SI-03.13 — Reconciliador de uploads abandonados e vídeos travados

**Description:** Manter a tabela `videos` consistente com o storage e recuperar jobs travados por meio do job agendado `cleanup-stale-uploads`, reutilizando o agendador do BullMQ.

**Technical actions:**

1. Criar `src/worker/reconciler/upload-reconciler.service.ts` — passo (1): vídeos `uploading` com `updated_at` mais antigo que `UPLOAD_ABANDON_AFTER_HOURS` → `abortMultipartUpload` + `failed`/`UPLOAD_ABANDONED`, `upload_id=NULL` (per `phase-03-videos/TD-11`)
2. Adicionar o passo (2): vídeos `processing` mais antigos que `PROCESSING_STUCK_AFTER_MINUTES` → `queue.getJob(videoId)` e ramificação por estado — `failed` ⇒ update condicional para `failed`/`PROCESSING_FAILED`; `completed` ou ausente ⇒ `job.remove()` se existir e re-enfileirar `process-video` com `jobId = videoId`; `active`/`waiting`/`delayed` ⇒ não tocar (per `phase-03-videos/TD-11`, `phase-03-videos/TD-06`)
3. Adicionar o passo (3): vídeos `failed` cujo original ainda existe (`headObject`) → `deleteObject` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-14`)
4. No boot do worker, registrar `upsertJobScheduler('cleanup-stale-uploads', { pattern: <cron horário> }, { name: 'cleanup-stale-uploads', data: {} })` e adicionar ao `VideoProcessor` o ramo `job.name === 'cleanup-stale-uploads'` → `UploadReconcilerService.run()` (um único processor por fila) (per `phase-03-videos/TD-11`, `phase-03-videos/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadReconcilerService` | Unit: ramificação por estado do job no passo (2) (mock queue/repo/storage) | `src/worker/reconciler/upload-reconciler.service.spec.ts` |
| `UploadReconcilerService` | Integration: Postgres + Redis + MinIO reais — os três passos com timestamps retroagidos | `src/worker/reconciler/upload-reconciler.service.integration-spec.ts` |

**Dependencies:** SI-03.12 — estende o `VideoProcessor` com o despacho do job agendado

**Acceptance criteria:**

- Um vídeo `uploading` com `updated_at` além do limite termina em `failed` com `processing_error = UPLOAD_ABANDONED`, `upload_id = NULL`, e seu multipart deixa de existir no storage
- Um vídeo `processing` travado sem job na fila recebe um novo job `process-video` com `jobId = videoId`
- Um vídeo `processing` travado cujo job está `failed` termina em `failed` com `processing_error = PROCESSING_FAILED`
- Um vídeo `processing` cujo job está `active` ou `waiting` permanece inalterado
- Um vídeo `failed` com original remanescente tem o objeto removido do bucket `videos`
- Reiniciar o worker não duplica o agendador `cleanup-stale-uploads` (existe exatamente um)
- Executar o reconciliador duas vezes seguidas não produz efeito adicional na segunda execução

---

### SI-03.14 — Atualizar o testing guide para storage, fila e FFmpeg

**Description:** Registrar no testing guide do `nestjs-project` a estratégia de serviços reais (MinIO, Redis, ffmpeg) adotada nesta fase, para que fases futuras sigam o mesmo padrão de isolamento.

**Technical actions:**

1. Atualizar `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` — seções de storage e fila descrevendo MinIO e Redis reais via Compose, isolamento por buckets de teste (`src/test/minio.ts`) e prefixo BullMQ (`src/test/redis.ts`), `obliterate` entre specs (per `phase-03-videos/TD-13`)
2. Adicionar ao testing guide a linha de artefato para processors BullMQ / serviços que executam binários externos (ffprobe/ffmpeg): Unit para ramificação + Integration com binário real sobre fixtures em `test/fixtures/media/` (per `phase-03-videos/TD-13`, `phase-03-videos/TD-05`)
3. Adicionar a `references/gotchas.md` os cuidados verificados nesta fase: `requestChecksumCalculation: 'WHEN_REQUIRED'` para presign em S3-compatível, `S3_PUBLIC_ENDPOINT=http://minio:9000` no ambiente de teste, fechar `Queue`/`Worker` no `afterAll` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)

**Tests:** _(empty — documentation-only SI)_

**Dependencies:** SI-03.13 — documenta os padrões efetivamente usados pelos testes das SIs anteriores

**Acceptance criteria:**

- O testing guide descreve como isolar testes de storage e fila e onde ficam os helpers e fixtures
- O checklist de artefatos do guide inclui processors BullMQ e serviços com binário externo, com as camadas exigidas
- Os gotchas listam checksum `WHEN_REQUIRED`, endpoint público em teste e fechamento de filas

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated — internal identity and storage key root (per `phase-03-videos/TD-07`; keys `videos/{videoId}/original`, `thumbnails/{videoId}/…`) |
| public_id | varchar(11) | unique, not null — random base62, 11 chars; generated at initiate with retry on unique-violation (per `phase-03-videos/TD-07`) |
| channel_id | uuid | FK → `channels.id`, not null, `ON DELETE CASCADE` — owner channel (per DG-1 clarification; owner user resolved via `channels.user_id`) |
| title | varchar(255) | not null — defaults to `fileName` without extension at initiate (per `phase-03-videos/TD-09` revision) |
| status | enum `video_status` (`draft`) | not null, default `'draft'` — editorial axis; Phase 04 extends the enum (per `phase-03-videos/TD-09`) |
| processing_status | enum `video_processing_status` (`uploading`, `processing`, `ready`, `failed`) | not null, default `'uploading'` — API owns `uploading→processing`, worker owns `processing→ready\|failed` (per `phase-03-videos/TD-09`) |
| processing_error | varchar(64) | nullable — typed code, set only with `processing_status=failed` (per `phase-03-videos/TD-14`; values in §Error Catalog → `processing_error` values) |
| original_filename | varchar(255) | not null — `fileName` declared at initiate (per `phase-03-videos/TD-09` revision) |
| content_type | varchar(100) | not null — `contentType` declared at initiate, allowlisted (per `phase-03-videos/TD-14`) |
| size_bytes | bigint | not null — `fileSize` declared at initiate, ≤ `UPLOAD_MAX_SIZE_BYTES` (per `phase-03-videos/TD-02`) |
| upload_id | varchar(1024) | nullable — S3 multipart `UploadId`; set at initiate, cleared (`NULL`) on complete/abort (per `phase-03-videos/TD-02`) |
| part_size | integer | not null — server-computed `partSize` returned at initiate (per `phase-03-videos/TD-02`) |
| part_count | integer | not null — `partCount = ceil(fileSize / partSize)` (per `phase-03-videos/TD-02`) |
| duration_seconds | numeric(12,3) | nullable — ffprobe `format.duration`, set by worker on success |
| width | integer | nullable — ffprobe video stream width |
| height | integer | nullable — ffprobe video stream height |
| video_codec | varchar(32) | nullable — ffprobe `codec_name` of the video stream (allowlisted, per `phase-03-videos/TD-14`) |
| audio_codec | varchar(32) | nullable — ffprobe `codec_name` of the audio stream, `NULL` when the file has no audio |
| thumbnail_key | varchar(255) | nullable — deterministic object key `thumbnails/{videoId}/default.jpg` in the `thumbnails` bucket; set by worker after the frame is written |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), auto-updated — used by the reconciler as "last transition" timestamp (per `phase-03-videos/TD-11`) |

**Relations:** `Channel` has many `Video` (one-to-many, `videos.channel_id` → `channels.id`). `Video` many-to-one `Channel`. No inverse relation is added to `User`.
**Indexes:** unique on `public_id`; btree on `channel_id`; btree on `(processing_status, updated_at)` — reconciler scans (`uploading` older than `UPLOAD_ABANDON_AFTER_HOURS`, stuck `processing`, `failed` with leftover original) (per `phase-03-videos/TD-11`).
**Migration:** single TypeORM migration `CreateVideos` creating both enums, the `videos` table, FK and indexes; `down` drops them in reverse order.
**Shared constant (not persisted):** `video-formats.ts` — the TD-14 allowlist, imported by both the initiate DTO validator and the worker validator (per `phase-03-videos/TD-14`):

| Extension → `contentType` | ffprobe `format_name` | Video codecs | Audio codecs |
|---|---|---|---|
| `.mp4`, `.m4v` → `video/mp4` | `mov,mp4,m4a,3gp,3g2,mj2` | `h264`, `av1` | `aac`, `mp3`, none |
| `.mov` → `video/quicktime` | `mov,mp4,m4a,3gp,3g2,mj2` | `h264` | `aac`, none |
| `.webm` → `video/webm` | `matroska,webm` | `vp8`, `vp9`, `av1` | `opus`, `vorbis`, none |

Structural checks on the probe result: ≥1 video stream (streams with `disposition.attached_pic=1` do not count); `format.duration` finite and > 0; `width`/`height` > 0.

### API Contracts

All endpoints below require `Authorization: Bearer <access_token>` (global `JwtAuthGuard`, inherited from Phase 02) and are owner-only: the video's `channel_id` must resolve to a channel whose `user_id` equals the JWT `sub`; any other caller receives `404 VIDEO_NOT_FOUND` (no existence leak). Error bodies use the inherited envelope `{ statusCode, error, message }` (per `phase-02-auth/TD-07`). Every endpoint is documented with explicit `@ApiOperation` / `@ApiResponse` decorators and lands in the committed `openapi.json` (per `openapi-docs-nestjs/TD-01` revision, `openapi-docs-nestjs/TD-02`). Bytes never pass through the API (per `phase-03-videos/TD-02` revision).

#### POST /videos (SI-03.8)

Pre-registers the video as a draft and opens the S3 multipart upload (per `phase-03-videos/TD-02`, `phase-03-videos/TD-09`, `phase-03-videos/TD-14`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- fileName: string, required — 1–255 chars; extension must be in the `video-formats.ts` allowlist (`.mp4`, `.m4v`, `.mov`, `.webm`)
- contentType: string, required — one of `video/mp4`, `video/quicktime`, `video/webm`; must agree with the `fileName` extension
- fileSize: integer, required — `1 ≤ fileSize ≤ UPLOAD_MAX_SIZE_BYTES` (default 10737418240)

**Side effects (in order):** generate the video `id` (UUID) in the application → `CreateMultipartUpload` on `videos/{videoId}/original` via the internal client → a single `INSERT` of the `videos` row already carrying `upload_id`, `part_size`, `part_count` (`status=draft`, `processing_status=uploading`, `title` = `fileName` without extension, `public_id` generated; unique-violation on `public_id` retries the INSERT with a new ID) → if the `INSERT` fails definitively, `AbortMultipartUpload` on the same `UploadId` before propagating the error. If `CreateMultipartUpload` fails, nothing is inserted.

**Response 201:**
- id: string (uuid)
- public_id: string (11-char base62)
- title: string
- status: `"draft"`
- processing_status: `"uploading"`
- partSize: integer — `max(UPLOAD_PART_SIZE_BYTES, ceil(fileSize / 10_000))` rounded up to a whole MiB (default 16 MiB)
- partCount: integer — `ceil(fileSize / partSize)`

**Error responses:**
- 400 VALIDATION_ERROR: body fails schema validation (missing field, `fileSize` out of range, wrong type)
- 400 UNSUPPORTED_VIDEO_FORMAT: `fileName` extension or `contentType` outside the allowlist, or the two disagree (per `phase-03-videos/TD-14`)
- 401: missing/invalid access token (inherited guard behavior)

---

#### POST /videos/:id/upload/parts (SI-03.8)

Returns presigned `UploadPart` URLs for the requested part numbers, signed with the **public** S3 client (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Path parameters:**
- id: string (uuid) — invalid UUID → 400 VALIDATION_ERROR

**Request body:**
- partNumbers: integer[], required — 1–100 unique items; each `1 ≤ n ≤ partCount`

**Response 200:**
- parts: array of `{ partNumber: integer, url: string }`
- expiresIn: integer — URL TTL in seconds (presigner default 900)

**Error responses:**
- 400 VALIDATION_ERROR: body/path fails schema validation
- 400 INVALID_PART_NUMBER: any `partNumber` > the video's `partCount`
- 404 VIDEO_NOT_FOUND: video does not exist or caller is not the owner
- 409 UPLOAD_NOT_IN_PROGRESS: `processing_status` ≠ `uploading`
- 401: missing/invalid access token

---

#### GET /videos/:id/upload/parts (SI-03.8)

Resume support: lists parts already stored, via paginated `ListParts` (loop until `IsTruncated=false`) (per `phase-03-videos/TD-02`).

**Request headers:**
- Authorization: Bearer <access_token>

**Path parameters:**
- id: string (uuid)

**Response 200:**
- partSize: integer
- partCount: integer
- uploadedParts: array of `{ partNumber: integer, size: integer }`

**Error responses:**
- 400 VALIDATION_ERROR: invalid UUID
- 404 VIDEO_NOT_FOUND: video does not exist or caller is not the owner
- 409 UPLOAD_NOT_IN_PROGRESS: `processing_status` ≠ `uploading`
- 401: missing/invalid access token

---

#### POST /videos/:id/upload/complete (SI-03.8)

Completes the multipart upload, verifies the size and enqueues processing (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`). The part list sent to `CompleteMultipartUpload` is built server-side from `ListParts` — never from client input.

**Request headers:**
- Authorization: Bearer <access_token>

**Path parameters:**
- id: string (uuid)

**Request body:** none.

**Side effects (in order):** `ListParts` → reject if stored parts ≠ `1..partCount` → `CompleteMultipartUpload` → `HeadObject` (`ContentLength` must equal `size_bytes`) → conditional update `processing_status: uploading→processing`, `upload_id=NULL` → enqueue `process-video` with `jobId = videoId` (see §Events/Messages). A crash between the update and the enqueue is recovered by the reconciler (per `phase-03-videos/TD-11`).

**Response 202:**
- id: string (uuid)
- public_id: string
- processing_status: `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: invalid UUID
- 400 UPLOAD_SIZE_MISMATCH: `HeadObject.ContentLength` ≠ declared `fileSize`; the object is deleted and the video set to `processing_status=failed`, `processing_error=UPLOAD_SIZE_MISMATCH` (per `phase-03-videos/TD-02`)
- 404 VIDEO_NOT_FOUND: video does not exist or caller is not the owner
- 409 UPLOAD_NOT_IN_PROGRESS: `processing_status` ≠ `uploading`
- 409 UPLOAD_INCOMPLETE: stored parts do not cover `1..partCount`
- 401: missing/invalid access token

---

#### DELETE /videos/:id/upload (SI-03.8)

Cancels an in-progress upload: `AbortMultipartUpload`, then `processing_status=failed`, `processing_error=UPLOAD_CANCELLED`, `upload_id=NULL` (per `phase-03-videos/TD-02`). The row is kept (deletion is a Phase 04 management concern).

**Request headers:**
- Authorization: Bearer <access_token>

**Path parameters:**
- id: string (uuid)

**Response 204:** No content.

**Error responses:**
- 400 VALIDATION_ERROR: invalid UUID
- 404 VIDEO_NOT_FOUND: video does not exist or caller is not the owner
- 409 UPLOAD_NOT_IN_PROGRESS: `processing_status` ≠ `uploading`
- 401: missing/invalid access token

---

#### GET /videos/:id (SI-03.9)

Owner-only read of the video's processing state and extracted metadata — lets the owner follow `uploading → processing → ready | failed` and see the thumbnail (per `phase-03-videos/TD-09`, `phase-03-videos/TD-12`; covers capabilities "Processamento automático do vídeo após upload (extração de duração e metadados)" and "Geração automática de thumbnail a partir de um frame do vídeo").

**Request headers:**
- Authorization: Bearer <access_token>

**Path parameters:**
- id: string (uuid) — invalid UUID → 400 VALIDATION_ERROR

**Response 200:**
- id: string (uuid)
- public_id: string
- title: string
- status: `"draft"`
- processing_status: `"uploading"` | `"processing"` | `"ready"` | `"failed"`
- processing_error: string | null — one of the `processing_error` values in §Error Catalog; `null` unless `failed`
- duration_seconds: number | null
- width: integer | null
- height: integer | null
- video_codec: string | null
- audio_codec: string | null
- thumbnail_url: string | null — public URL of the object in the anonymous-read `thumbnails` bucket, built from `S3_PUBLIC_ENDPOINT` + bucket + `thumbnail_key` (path-style); `null` until `processing_status=ready` (per `phase-03-videos/TD-12`, `phase-03-videos/TD-04`)

**Error responses:**
- 400 VALIDATION_ERROR: invalid UUID
- 404 VIDEO_NOT_FOUND: video does not exist or caller is not the owner
- 401: missing/invalid access token

---

#### GET /videos/:publicId/stream (SI-03.9)

Authorizes, then redirects to a short-lived presigned `GetObject` URL signed with the **public** client; the player issues Range requests directly to storage (206 handled by storage) (per `phase-03-videos/TD-08`, `phase-03-videos/TD-04`).

**Request headers:**
- Authorization: Bearer <access_token>

**Path parameters:**
- publicId: string — 11-char base62 (`^[0-9A-Za-z]{11}$`); malformed → 404 VIDEO_NOT_FOUND

**Response 302:**
- Location: presigned GET URL for `videos/{videoId}/original`, `expiresIn = PRESIGNED_GET_TTL_SECONDS`, `ResponseContentType` = stored `content_type`
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: video does not exist or caller is not the owner (per `phase-03-videos/TD-08` revision)
- 409 VIDEO_NOT_READY: owner request while `processing_status` ≠ `ready`
- 401: missing/invalid access token

**Known limitation:** a browser `<video src>` element does not send an `Authorization` header, so an owner-only bearer-protected `/stream` cannot be used directly as a `<video src>` in this phase. Accepted until Phase 04/05 opens public access (visibility rules); the frontend player is deferred anyway (see context.md `## Non-UI / Deferred Capabilities`).

---

#### GET /videos/:publicId/download (SI-03.9)

Same authorization as `/stream`; the presigned URL bakes `ResponseContentDisposition: attachment; filename*=UTF-8''<original_filename percent-encoded>` and `ResponseContentType` into the signature (per `phase-03-videos/TD-08`).

**Request headers:**
- Authorization: Bearer <access_token>

**Path parameters:**
- publicId: string — 11-char base62; malformed → 404 VIDEO_NOT_FOUND

**Response 302:**
- Location: presigned GET URL with attachment disposition, `expiresIn = PRESIGNED_GET_TTL_SECONDS`
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: video does not exist or caller is not the owner
- 409 VIDEO_NOT_READY: owner request while `processing_status` ≠ `ready`
- 401: missing/invalid access token

**Test note (per `phase-03-videos/TD-13`):** in the test environment `S3_PUBLIC_ENDPOINT=http://minio:9000`, so presigned URLs resolve from inside the `nestjs-api` container. The e2e specs follow the `Location` of `/stream` with a `Range` header and assert `206` + `Content-Range`, and follow the `Location` of `/download` and assert `Content-Disposition: attachment`.

---

#### Validation Rules — Upload initiate

- `fileName`: required, string, 1–255 chars, extension (case-insensitive) ∈ `video-formats.ts` allowlist
- `contentType`: required, string, ∈ {`video/mp4`, `video/quicktime`, `video/webm`}, must map from the `fileName` extension (`.mp4`/`.m4v` → `video/mp4`, `.mov` → `video/quicktime`, `.webm` → `video/webm`)
- `fileSize`: required, integer, `1 ≤ fileSize ≤ UPLOAD_MAX_SIZE_BYTES`
- `partNumbers`: required, array of 1–100 unique integers, each ≥ 1 (upper bound `partCount` checked in service → `INVALID_PART_NUMBER`)
- Schema violations go through `class-validator` → `VALIDATION_ERROR` (per `phase-02-auth/TD-06`); allowlist/agreement violations raise the domain exception `UNSUPPORTED_VIDEO_FORMAT` so the deferred frontend can switch on the code (per `phase-03-videos/TD-14`)

### Authorization Matrix

Owner = authenticated user whose channel owns the video (`videos.channel_id` → `channels.user_id = sub`). Non-owners receive `404 VIDEO_NOT_FOUND`, never `403` (per `phase-03-videos/TD-08` revision — every video is pre-publication in Phase 03; Phase 04 opens access via visibility rules).

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | n/a (creates own video) |
| POST /videos/:id/upload/parts | ✗ | ✗ | ✓ |
| GET /videos/:id/upload/parts | ✗ | ✗ | ✓ |
| POST /videos/:id/upload/complete | ✗ | ✗ | ✓ |
| DELETE /videos/:id/upload | ✗ | ✗ | ✓ |
| GET /videos/:id | ✗ | ✗ | ✓ |
| GET /videos/:publicId/stream | ✗ | ✗ | ✓ (only when `processing_status=ready`) |
| GET /videos/:publicId/download | ✗ | ✗ | ✓ (only when `processing_status=ready`) |

Storage-side access (per `phase-03-videos/TD-08`, `phase-03-videos/TD-04`): the `videos` bucket is private — reachable only through presigned URLs issued by the endpoints above; the `thumbnails` bucket allows anonymous read.

### Error Catalog

HTTP errors (envelope `{ statusCode, error, message }`, inherited from `phase-02-auth/TD-07`; each code is a `DomainException` subclass in `src/common/exceptions/` or the videos module):

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| UNSUPPORTED_VIDEO_FORMAT | 400 | Initiate com extensão de `fileName` ou `contentType` fora da allowlist, ou os dois discordando (per `phase-03-videos/TD-14`) |
| INVALID_PART_NUMBER | 400 | Pedido de URLs com `partNumber` maior que o `partCount` do vídeo |
| UPLOAD_SIZE_MISMATCH | 400 | No complete, `HeadObject.ContentLength` ≠ `fileSize` declarado; objeto removido e vídeo marcado `failed` (per `phase-03-videos/TD-02`) |
| VIDEO_NOT_FOUND | 404 | Vídeo inexistente, `publicId` malformado, ou chamador não é o dono — em todos os endpoints de vídeo, incluindo `GET /videos/:id` (per `phase-03-videos/TD-08` revision) |
| UPLOAD_NOT_IN_PROGRESS | 409 | Operação de upload (parts/complete/cancel) com `processing_status` ≠ `uploading` |
| UPLOAD_INCOMPLETE | 409 | Complete com partes armazenadas que não cobrem `1..partCount` |
| VIDEO_NOT_READY | 409 | Stream/download pelo dono com `processing_status` ≠ `ready` |
| VALIDATION_ERROR | 400 | Falha de schema (`class-validator` / `ParseUUIDPipe`) — inherited |

`processing_error` values (persisted on `videos.processing_error`, not HTTP responses; always paired with `processing_status=failed`):

| processing_error | Set by | Trigger |
|------------------|--------|---------|
| NOT_A_VIDEO | worker | ffprobe finds no video stream (attached pictures excluded) — `UnrecoverableError` (per `phase-03-videos/TD-14`) |
| UNSUPPORTED_CONTAINER | worker | ffprobe `format_name` outside the allowlist — `UnrecoverableError` (per `phase-03-videos/TD-14`) |
| UNSUPPORTED_CODEC | worker | video or audio `codec_name` outside the allowlist for the container — `UnrecoverableError` (per `phase-03-videos/TD-14`) |
| CORRUPT_MEDIA | worker | ffprobe exits non-zero on a parse error (e.g., `Invalid data found when processing input`, `moov atom not found`) or structural checks fail (duration/width/height) — `UnrecoverableError` (per `phase-03-videos/TD-14`) |
| PROCESSING_FAILED | worker | transient failure (storage/ffmpeg I/O) persisted after all `attempts` are exhausted (per `phase-03-videos/TD-10`) |
| UPLOAD_SIZE_MISMATCH | API | complete-time size check failed (per `phase-03-videos/TD-02`) |
| UPLOAD_CANCELLED | API | owner called `DELETE /videos/:id/upload` |
| UPLOAD_ABANDONED | reconciler | `uploading` older than `UPLOAD_ABANDON_AFTER_HOURS`; multipart aborted (per `phase-03-videos/TD-11`) |

On any media failure (`NOT_A_VIDEO`, `UNSUPPORTED_CONTAINER`, `UNSUPPORTED_CODEC`, `CORRUPT_MEDIA`) the worker deletes `videos/{videoId}/original` and the `thumbnails/{videoId}/` prefix; a failed delete does not change the job outcome — the reconciler sweeps it later (per `phase-03-videos/TD-14`).

### Events/Messages

Queue `video-processing` on BullMQ over Redis (`REDIS_HOST=redis`, `REDIS_PORT=6379`; Redis runs with `maxmemory-policy noeviction`). Registered via `@nestjs/bullmq` `BullModule.forRootAsync` (option key `connection`) + `BullModule.registerQueue` in both API and worker; the `@Processor` providers are registered **only** in the worker module (per `phase-03-videos/TD-01`).

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoProcessingProducer` (API, called from `VideosService.completeUpload`) (per `phase-03-videos/TD-06`); also re-enqueued by the reconciler for stuck `processing` rows (per `phase-03-videos/TD-11`)
**Consumer:** `VideoProcessor` (worker container, `@Processor('video-processing')`, `job.name === 'process-video'` branch) (per `phase-03-videos/TD-01`)
**Trigger:** `POST /videos/:id/upload/complete` succeeds and the row transitions `uploading→processing`.
**Job options:** `jobId = videoId`, `attempts: 3`, `backoff: { type: 'exponential', delay: 10_000 }`, `removeOnComplete` / `removeOnFail` with `age` retention long enough for `jobId` dedup (per `phase-03-videos/TD-10`).
**Processing:** skip if `processing_status` is already `ready` → presign internal GET for the original → ffprobe (`execFile`, JSON output) → validate against `video-formats.ts` + structural checks → ffmpeg extracts one frame at `min(1s, duration * 0.1)`, encoded as JPEG → `PutObject` (`ContentType: image/jpeg`) to the deterministic key `thumbnails/{videoId}/default.jpg` in the `thumbnails` bucket (overwritten on re-run, never duplicated) → conditional `UPDATE … SET processing_status='ready', duration_seconds, width, height, video_codec, audio_codec, thumbnail_key WHERE id=? AND processing_status='processing'`.
**Failure handling:** invalid media → `UnrecoverableError` (no retry); on final failure (`attemptsMade ≥ attempts` or unrecoverable) the `failed` worker event sets `processing_status=failed` + typed `processing_error` with the same conditional `WHERE processing_status='processing'` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-14`).
**Delivery semantics:** at-least-once; duplicates are harmless because the processor is idempotent and outputs are deterministic (per `phase-03-videos/TD-10`).

#### cleanup-stale-uploads

**Payload:**

```json
{}
```

**Producer:** BullMQ job scheduler registered on worker boot with `upsertJobScheduler('cleanup-stale-uploads', …)` (idempotent by scheduler id), hourly cron (per `phase-03-videos/TD-11`)
**Consumer:** the single `@Processor('video-processing')` worker host dispatches by `job.name` to `UploadReconcilerService` (worker container) — one processor per queue, so `process-video` and `cleanup-stale-uploads` never compete for separate workers
**Trigger:** schedule.
**Work per run:** (1) `uploading` rows with `updated_at` older than `UPLOAD_ABANDON_AFTER_HOURS` → `AbortMultipartUpload` + `processing_status=failed`, `processing_error=UPLOAD_ABANDONED`, `upload_id=NULL`; (2) `processing` rows with `updated_at` older than `PROCESSING_STUCK_AFTER_MINUTES` → `queue.getJob(videoId)` and branch on its state, because BullMQ ignores `add()` when a job with the same `jobId` exists in **any** state: job `failed` ⇒ conditional update to `processing_status=failed`, `processing_error=PROCESSING_FAILED`; job `completed` or absent ⇒ `job.remove()` when it exists, then re-add `process-video` (`jobId = videoId`); job `active`/`waiting`/`delayed` ⇒ leave untouched; (3) `failed` rows whose original object still exists (`HeadObject`) → `DeleteObject` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-14`). Storage-level stale-multipart expiry (MinIO `MINIO_API_STALE_UPLOADS_EXPIRY`) stays configured as backstop.
**Configuration:** `UPLOAD_ABANDON_AFTER_HOURS` (abandon threshold for `uploading`, per `phase-03-videos/TD-11`) and `PROCESSING_STUCK_AFTER_MINUTES` (stuck threshold for `processing`), both validated in the Joi env schema with defaults.
**Delivery semantics:** at-least-once; every step is a conditional/idempotent operation.

---

## Dependency Map

```
SI-03.1 (root)
└── SI-03.2 — depends on SI-03.1 (config defaults point to minio/redis services)
    ├── SI-03.3 — depends on SI-03.2 (storageConfig)
    └── SI-03.6 — depends on SI-03.2 (redisConfig)
SI-03.4 (root — depends only on Phase 02 Channel)
SI-03.5 (root, independent)

SI-03.3 + SI-03.4 + SI-03.5 + SI-03.6
└── SI-03.7 — VideosService upload lifecycle
    └── SI-03.8 — upload endpoints (controller wiring)
        └── SI-03.9 — read/stream/download endpoints

SI-03.3 + SI-03.4 + SI-03.6
└── SI-03.10 — worker runtime

SI-03.5 + SI-03.10
└── SI-03.11 — media services (ffprobe/ffmpeg)

SI-03.7 + SI-03.11
└── SI-03.12 — VideoProcessor
    └── SI-03.13 — reconciler (extends VideoProcessor dispatch)
        └── SI-03.14 — testing guide update
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3, SI-03.4, SI-03.5, SI-03.6 (parallel) → SI-03.7 → SI-03.8, SI-03.10 (parallel) → SI-03.9, SI-03.11 (parallel) → SI-03.12 → SI-03.13 → SI-03.14

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências e serviços Compose (MinIO, Redis, buckets)
- [ ] SI-03.2 — Infra: namespaces de configuração storage, redis e upload
- [ ] SI-03.3 — StorageModule com clientes S3 interno e público
- [ ] SI-03.4 — Entidade Video e migration CreateVideos
- [ ] SI-03.5 — Allowlist de formatos e gerador de public ID
- [ ] SI-03.6 — QueueModule e VideoProcessingProducer
- [ ] SI-03.7 — VideosService: pré-cadastro e ciclo de vida do upload multipart
- [ ] SI-03.8 — Endpoints de upload multipart (initiate, parts, complete, cancel)
- [ ] SI-03.9 — Endpoints de consulta, streaming e download
- [ ] SI-03.10 — Infra: runtime do Video Worker (entrypoint, módulo e container com FFmpeg)
- [ ] SI-03.11 — Serviços de mídia do worker: probe (ffprobe) e thumbnail (ffmpeg)
- [ ] SI-03.12 — VideoProcessor: processamento automático e geração de thumbnail
- [ ] SI-03.13 — Reconciliador de uploads abandonados e vídeos travados
- [ ] SI-03.14 — Atualizar o testing guide para storage, fila e FFmpeg

**Full test suites:**

- [ ] Backend unit tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Backend integration tests pass (`docker compose exec nestjs-api npm run test:integration`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully, API and worker entrypoints (`docker compose exec nestjs-api npm run build`)
