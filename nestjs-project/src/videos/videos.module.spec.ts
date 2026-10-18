import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { StorageService } from '../storage/storage.service';
import { createTestDataSource } from '../test/create-test-data-source';
import { testQueuePrefix, testRedisConfig } from '../test/redis';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile with the Video repository, Channels, Storage and Queue wired', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            storageConfig,
            uploadConfig,
            testRedisConfig(testQueuePrefix()),
          ],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    expect(module.get(VideosController)).toBeInstanceOf(VideosController);
    expect(module.get(getRepositoryToken(Video))).toBeDefined();
    expect(module.get(ChannelsService)).toBeInstanceOf(ChannelsService);
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(module.get(VideoProcessingProducer)).toBeInstanceOf(
      VideoProcessingProducer,
    );
    expect(module.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();
    await module.close();
  }, 30000);
});
