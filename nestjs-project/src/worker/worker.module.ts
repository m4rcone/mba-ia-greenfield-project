import { Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { configModuleOptions } from '../config/config-module.options';
import databaseConfig from '../config/database.config';
import { typeOrmConnectionOptions } from '../database/typeorm-connection.options';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { MediaProbeService } from './media/media-probe.service';
import { ThumbnailService } from './media/thumbnail.service';
import { VideoProcessingService } from './processors/video-processing.service';
import { VideoProcessor } from './processors/video.processor';
import { ReconcilerScheduler } from './reconciler/reconciler.scheduler';
import { UploadReconcilerService } from './reconciler/upload-reconciler.service';

/**
 * Root of the video worker process. The only module that registers BullMQ
 * `@Processor` providers, so the API never consumes jobs (TD-01, TD-05).
 */
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        ...typeOrmConnectionOptions(dbConfig),
        // Channel and User close the relation graph Video → Channel → User.
        entities: [Video, Channel, User],
      }),
    }),
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    QueueModule,
  ],
  providers: [
    MediaProbeService,
    ThumbnailService,
    VideoProcessingService,
    VideoProcessor,
    UploadReconcilerService,
    ReconcilerScheduler,
  ],
})
export class WorkerModule implements OnApplicationShutdown {
  onApplicationShutdown(signal?: string): void {
    Logger.log(
      `Video worker stopped (${signal ?? 'close'})`,
      WorkerModule.name,
    );
  }
}
