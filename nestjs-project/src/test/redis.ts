import { registerAs } from '@nestjs/config';
import { Queue } from 'bullmq';
import redisConfig from '../config/redis.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';

/** Unique per suite run so suites never share BullMQ keys with dev queues or each other. */
export function testQueuePrefix(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `redis` namespace pointing BullMQ at the given test prefix. */
export function testRedisConfig(queuePrefix: string) {
  return registerAs('redis', () => ({ ...redisConfig(), queuePrefix }));
}

export function createTestQueue(
  queuePrefix: string,
  name: string = VIDEO_PROCESSING_QUEUE,
): Queue {
  const { host, port } = redisConfig();
  return new Queue(name, { connection: { host, port }, prefix: queuePrefix });
}

export async function obliterateTestQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}
