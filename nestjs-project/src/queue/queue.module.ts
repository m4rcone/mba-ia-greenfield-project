import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import redisConfig from '../config/redis.config';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';
import { VideoProcessingProducer } from './video-processing.producer';

// Shared by the API and the worker; @Processor providers live only in the worker module.
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>) => ({
        connection: { host: config.host, port: config.port },
        prefix: config.queuePrefix,
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [VideoProcessingProducer],
  exports: [BullModule, VideoProcessingProducer],
})
export class QueueModule {}
