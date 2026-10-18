import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  S3_ENDPOINT: Joi.string().uri().default('http://minio:9000'),
  S3_PUBLIC_ENDPOINT: Joi.string().uri().default('http://localhost:9000'),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_ACCESS_KEY: Joi.string().required(),
  S3_SECRET_KEY: Joi.string().required(),
  S3_FORCE_PATH_STYLE: Joi.string().valid('true', 'false').default('true'),
  S3_BUCKET_VIDEOS: Joi.string().default('videos'),
  S3_BUCKET_THUMBNAILS: Joi.string().default('thumbnails'),
  PRESIGNED_GET_TTL_SECONDS: Joi.number().integer().positive().default(14400),
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().port().default(6379),
  BULLMQ_PREFIX: Joi.string().default('bull'),
  UPLOAD_MAX_SIZE_BYTES: Joi.number().integer().positive().default(10737418240),
  UPLOAD_PART_SIZE_BYTES: Joi.number()
    .integer()
    .min(5 * 1024 * 1024)
    .default(16 * 1024 * 1024),
  UPLOAD_ABANDON_AFTER_HOURS: Joi.number().integer().positive().default(24),
  PROCESSING_STUCK_AFTER_MINUTES: Joi.number().integer().positive().default(60),
});
