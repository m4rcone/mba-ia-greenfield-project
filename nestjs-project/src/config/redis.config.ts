import { registerAs } from '@nestjs/config';

export default registerAs('redis', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  // BullMQ key prefix; tests override it per suite for isolation.
  queuePrefix: process.env.BULLMQ_PREFIX || 'bull',
}));
