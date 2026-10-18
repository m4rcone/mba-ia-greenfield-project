import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY!,
  secretKey: process.env.S3_SECRET_KEY!,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  buckets: {
    videos: process.env.S3_BUCKET_VIDEOS || 'videos',
    thumbnails: process.env.S3_BUCKET_THUMBNAILS || 'thumbnails',
  },
  presignedGetTtlSeconds: parseInt(
    process.env.PRESIGNED_GET_TTL_SECONDS || '14400',
    10,
  ),
}));
