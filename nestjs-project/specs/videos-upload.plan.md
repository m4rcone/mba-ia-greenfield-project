---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-upload.e2e-spec.ts
---

# Videos Upload (multipart handshake) Test Plan

## Application Overview

Os endpoints de upload expõem o handshake de upload multipart S3 via REST sem que nenhum byte de vídeo passe pela API. `POST /videos` pré-cadastra o vídeo como rascunho (`status=draft`, `processing_status=uploading`) e abre o multipart no MinIO. `POST /videos/:id/upload/parts` entrega URLs presignadas de `UploadPart` assinadas com o client **público**. `GET /videos/:id/upload/parts` lista as partes já armazenadas para permitir retomada. `POST /videos/:id/upload/complete` fecha o multipart com a lista de partes montada no servidor, confere o tamanho e enfileira o processamento. `DELETE /videos/:id/upload` cancela o upload. Todas as rotas exigem bearer token (`JwtAuthGuard` global). As rotas sobre um vídeo existente são owner-only, e quem não é dono recebe `404 VIDEO_NOT_FOUND`, sem vazar a existência do vídeo. Os erros usam o envelope `{ statusCode, error, message }`.

## Test Scenarios

### 1. Upload multipart — initiate, parts, complete, cancel

**Setup:** `beforeAll` faz bootstrap de `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global de `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`). `beforeEach` roda `cleanAllTables(dataSource)` e esvazia a fila `video-processing` (`queue.obliterate({ force: true })`). Há dois usuários confirmados (dono e outro), com `access_token` obtido via signup → captura do token no Mailpit → `GET /auth/confirm-email` → `POST /auth/login` (mesmo helper de `test/auth.e2e-spec.ts`). Postgres, MinIO (`S3_PUBLIC_ENDPOINT=http://minio:9000`) e Redis são reais. As partes são enviadas com `PUT` direto na URL presignada (fora do `app`). Para manter os uploads pequenos, um arquivo de teste usa `fileSize` ≤ `UPLOAD_PART_SIZE_BYTES` (1 parte). `afterAll` chama `app.close()`.

#### 1.1. initiate-grande-retorna-201-com-particionamento

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. POST /videos (token do dono) com `{ fileName: "clip.mp4", contentType: "video/mp4", fileSize: 10737418240 }`
    - expect: HTTP 201
    - expect: body contém `id` (uuid), `title: "clip"`, `status: "draft"`, `processing_status: "uploading"`, `partSize: 16777216`, `partCount: 640`
    - expect: `public_id` casa `^[0-9A-Za-z]{11}$`
    - expect: a linha em `videos` existe com `upload_id` não nulo, `part_size = 16777216`, `part_count = 640`

#### 1.2. initiate-rejeita-formato-e-validacao

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. POST /videos com `{ fileName: "clip.avi", contentType: "video/mp4", fileSize: 1024 }`
    - expect: HTTP 400 com `error: "UNSUPPORTED_VIDEO_FORMAT"`
  2. POST /videos com `{ fileName: "clip.mp4", contentType: "video/mp4", fileSize: 0 }`
    - expect: HTTP 400 com `error: "VALIDATION_ERROR"`
    - expect: nenhuma linha é criada em `videos` em nenhum dos dois casos

#### 1.3. presign-parts-retorna-urls-publicas-e-valida-part-number

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. Dono inicia um upload com `fileSize` que gera ≥ 2 partes (ex.: `2 × UPLOAD_PART_SIZE_BYTES`)
    - expect: HTTP 201 com `partCount ≥ 2`
  2. POST /videos/:id/upload/parts com `{ partNumbers: [1, 2] }`
    - expect: HTTP 200 com `parts` de tamanho 2, `partNumber` 1 e 2, e `expiresIn: 900`
    - expect: o host de cada `url` é o de `S3_PUBLIC_ENDPOINT`
  3. POST /videos/:id/upload/parts com `{ partNumbers: [partCount + 1] }`
    - expect: HTTP 400 com `error: "INVALID_PART_NUMBER"`

#### 1.4. list-uploaded-parts-reflete-parte-enviada

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. Dono inicia um upload com 2 partes e pede a URL da parte 1
    - expect: HTTP 200
  2. Cliente de teste faz `PUT` dos bytes da parte 1 direto na URL presignada
    - expect: o storage responde 200 com header `ETag`
  3. GET /videos/:id/upload/parts
    - expect: HTTP 200 com `partSize` e `partCount` iguais aos do initiate
    - expect: `uploadedParts` contém `{ partNumber: 1, size: <bytes enviados> }` e não contém a parte 2

#### 1.5. complete-enfileira-e-repeticao-retorna-409

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. Dono inicia um upload de 1 parte, pede a URL e faz `PUT` de exatamente `fileSize` bytes
    - expect: o storage responde 200
  2. POST /videos/:id/upload/complete
    - expect: HTTP 202 com `{ id, public_id, processing_status: "processing" }`
    - expect: no DB, `processing_status = processing` e `upload_id IS NULL`
    - expect: a fila `video-processing` tem um job `process-video` com `jobId = id`
  3. POST /videos/:id/upload/complete de novo
    - expect: HTTP 409 com `error: "UPLOAD_NOT_IN_PROGRESS"`

#### 1.6. cancel-retorna-204-e-nao-dono-recebe-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. Dono inicia um upload; DELETE /videos/:id/upload com token de **outro** usuário
    - expect: HTTP 404 com `error: "VIDEO_NOT_FOUND"`
    - expect: o vídeo continua com `processing_status = uploading`
  2. DELETE /videos/:id/upload com o token do dono
    - expect: HTTP 204 com corpo vazio
    - expect: no DB, `processing_status = failed`, `processing_error = UPLOAD_CANCELLED` e `upload_id IS NULL`

#### 1.7. rotas-sem-token-retornam-401

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. Chamar POST /videos, POST /videos/:id/upload/parts, GET /videos/:id/upload/parts, POST /videos/:id/upload/complete e DELETE /videos/:id/upload sem header `Authorization` (`:id` = um uuid válido qualquer)
    - expect: HTTP 401 em todas as cinco rotas

#### 1.8. openapi-contem-operacoes-de-upload

**Covers AC:** #9
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. Ler o `openapi.json` commitado na raiz do `nestjs-project`
    - expect: `paths` contém `/videos` (post), `/videos/{id}/upload/parts` (post, get), `/videos/{id}/upload/complete` (post) e `/videos/{id}/upload` (delete)
    - expect: cada operação declara os status de erro do Error Catalog (ex.: post `/videos` com `400` e `401`; complete com `400`, `404` e `409`)
