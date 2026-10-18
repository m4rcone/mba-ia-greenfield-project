---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-playback.e2e-spec.ts
---

# Videos Query, Stream & Download Test Plan

## Application Overview

Com estes endpoints o dono acompanha o processamento do vídeo e assiste ou baixa o arquivo. `GET /videos/:id` devolve o estado de processamento e os metadados extraídos (duração, dimensões, codecs), além do `thumbnail_url` público, que fica `null` enquanto o vídeo não está `ready`. `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` autorizam o dono e respondem `302` com `Cache-Control: no-store`, redirecionando para uma URL presignada de `GetObject`. É o storage que atende `Range`/`206`, sem bytes passarem pelo Node. No download, a URL já embute `Content-Disposition: attachment` com o nome original. Todas as rotas exigem bearer token. Quem não é dono, um `publicId` malformado e um vídeo inexistente recebem `404 VIDEO_NOT_FOUND`. Um vídeo que ainda não está `ready` retorna `409 VIDEO_NOT_READY`.

## Test Scenarios

### 1. Consulta, streaming e download do vídeo pelo dono

**Setup:** `beforeAll` faz bootstrap de `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global de `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`). `beforeEach` roda `cleanAllTables(dataSource)`. Há dois usuários confirmados (dono e outro), com `access_token` obtido pelo mesmo helper de `test/auth.e2e-spec.ts`. Postgres e MinIO são reais (`S3_PUBLIC_ENDPOINT=http://minio:9000`, então as URLs presignadas resolvem de dentro do container). O vídeo "em processamento" é criado pelo fluxo real de upload (initiate → `PUT` da parte → complete). O vídeo "ready" é derivado dele: o worker não roda no E2E, então o teste faz `UPDATE videos SET processing_status='ready', duration_seconds, width, height, video_codec, audio_codec, thumbnail_key` e `PutObject` de um JPEG em `thumbnails/{videoId}/...`. O `original_filename` usado tem caracteres UTF-8 (ex.: `"vídeo de férias.mp4"`). `afterAll` chama `app.close()`.

#### 1.1. get-video-antes-de-ready-tem-thumbnail-nula

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. Dono inicia um upload (sem concluir); GET /videos/:id com o token do dono
    - expect: HTTP 200 com `processing_status: "uploading"`, `status: "draft"` e `thumbnail_url: null`
  2. Dono conclui o upload; GET /videos/:id
    - expect: HTTP 200 com `processing_status: "processing"`, `thumbnail_url: null` e metadados (`duration_seconds`, `width`, `height`, `video_codec`) `null`

#### 1.2. get-video-ready-expoe-metadados-e-thumbnail-publica

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. Promover o vídeo para `ready` (ver Setup); GET /videos/:id com o token do dono
    - expect: HTTP 200 com `processing_status: "ready"`, `processing_error: null` e os valores semeados de `duration_seconds`, `width`, `height` e `video_codec`
    - expect: `thumbnail_url` começa com `S3_PUBLIC_ENDPOINT` + `/thumbnails/` (path-style)
  2. `GET` anônimo (sem `Authorization`) em `thumbnail_url`
    - expect: o storage responde 200 com `Content-Type` de imagem

#### 1.3. stream-redireciona-e-storage-atende-range

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. GET /videos/:publicId/stream com o token do dono, sem seguir redirects (vídeo `ready`)
    - expect: HTTP 302 com header `Cache-Control: no-store`
    - expect: o host de `Location` é o de `S3_PUBLIC_ENDPOINT` e a URL contém os parâmetros de assinatura (`X-Amz-Signature`)
  2. `GET` em `Location` com header `Range: bytes=0-1023`
    - expect: o storage responde 206 com `Content-Range: bytes 0-1023/<size>` e corpo de 1024 bytes

#### 1.4. download-redireciona-com-content-disposition-attachment

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. GET /videos/:publicId/download com o token do dono, sem seguir redirects (vídeo `ready`)
    - expect: HTTP 302 com `Cache-Control: no-store`
  2. `GET` em `Location`
    - expect: o storage responde 200 com `Content-Disposition` começando com `attachment` e contendo `filename*=UTF-8''` + o `original_filename` percent-encoded

#### 1.5. stream-e-download-de-video-em-processing-retornam-409

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. Vídeo do dono com `processing_status = processing`; GET /videos/:publicId/stream
    - expect: HTTP 409 com `error: "VIDEO_NOT_READY"`
  2. GET /videos/:publicId/download do mesmo vídeo
    - expect: HTTP 409 com `error: "VIDEO_NOT_READY"`

#### 1.6. stream-publicid-malformado-inexistente-ou-alheio-retorna-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. GET /videos/abc!/stream (malformado) com o token do dono
    - expect: HTTP 404 com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/:publicId/stream com um `publicId` bem-formado, de 11 caracteres, que não existe
    - expect: HTTP 404 com `error: "VIDEO_NOT_FOUND"`
  3. GET /videos/:publicId/stream de um vídeo `ready` do dono, usando o token de **outro** usuário
    - expect: HTTP 404 com `error: "VIDEO_NOT_FOUND"` (nunca 403 nem 409)
  4. GET /videos/:id do mesmo vídeo com o token do outro usuário
    - expect: HTTP 404 com `error: "VIDEO_NOT_FOUND"`

#### 1.7. rotas-sem-token-retornam-401

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-18T03:52:20Z

**Steps:**
  1. Chamar GET /videos/:id, GET /videos/:publicId/stream e GET /videos/:publicId/download sem header `Authorization`
    - expect: HTTP 401 nas três rotas
