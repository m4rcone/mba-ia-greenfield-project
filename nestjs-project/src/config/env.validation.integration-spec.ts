import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';
import redisConfig from './redis.config';
import storageConfig from './storage.config';
import uploadConfig from './upload.config';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
};

const validate = (
  env: Record<string, string>,
): { value: Record<string, unknown>; error?: ValidationError } =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, redis and upload keys', () => {
  it.each(['S3_ACCESS_KEY', 'S3_SECRET_KEY'])(
    'should reject when %s is missing',
    (key) => {
      const env: Record<string, string | undefined> = { ...requiredEnv };
      delete env[key];

      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply defaults for optional storage, redis and upload keys', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'true',
      S3_BUCKET_VIDEOS: 'videos',
      S3_BUCKET_THUMBNAILS: 'thumbnails',
      PRESIGNED_GET_TTL_SECONDS: 14400,
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      BULLMQ_PREFIX: 'bull',
      UPLOAD_MAX_SIZE_BYTES: 10737418240,
      UPLOAD_PART_SIZE_BYTES: 16777216,
      UPLOAD_ABANDON_AFTER_HOURS: 24,
      PROCESSING_STUCK_AFTER_MINUTES: 60,
    });
  });

  it('should reject UPLOAD_PART_SIZE_BYTES below the 5 MiB S3 minimum', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '1048576' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });

  it('should reject S3_FORCE_PATH_STYLE with an invalid value', () => {
    const { error } = validate({ S3_FORCE_PATH_STYLE: 'yes' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_FORCE_PATH_STYLE');
  });
});

describe('config namespaces — defaults', () => {
  const keys = [
    'REDIS_HOST',
    'REDIS_PORT',
    'UPLOAD_MAX_SIZE_BYTES',
    'UPLOAD_PART_SIZE_BYTES',
    'UPLOAD_ABANDON_AFTER_HOURS',
    'PROCESSING_STUCK_AFTER_MINUTES',
    'S3_BUCKET_VIDEOS',
    'S3_BUCKET_THUMBNAILS',
    'S3_FORCE_PATH_STYLE',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    keys.forEach((key) => delete process.env[key]);
  });

  afterEach(() => {
    keys.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });

  it('should expose the Compose service name as the default redis host', () => {
    expect(redisConfig()).toEqual({
      host: 'redis',
      port: 6379,
      queuePrefix: 'bull',
    });
  });

  it('should expose 10 GiB as the default upload max size', () => {
    expect(uploadConfig()).toEqual({
      maxSizeBytes: 10737418240,
      partSizeBytes: 16777216,
      abandonAfterHours: 24,
      processingStuckAfterMinutes: 60,
    });
  });

  it('should default bucket names and path-style addressing', () => {
    const config = storageConfig();

    expect(config.buckets).toEqual({
      videos: 'videos',
      thumbnails: 'thumbnails',
    });
    expect(config.forcePathStyle).toBe(true);
  });
});
