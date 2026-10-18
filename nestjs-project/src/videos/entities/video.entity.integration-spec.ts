import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoProcessingStatus, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `videochan${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      public_id: 'aB3dE5gH7jK',
      channel_id: channelId,
      title: 'My video',
      original_filename: 'my-video.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      upload_id: 'upload-id',
      part_size: 5 * 1024 * 1024,
      part_count: 1,
      ...overrides,
    });
  }

  it('should enforce unique public_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id));

    await expect(
      videoRepository.save(buildVideo(channel.id)),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('should default status to draft and processing_status to uploading', async () => {
    const channel = await createChannel();
    const { id } = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOneByOrFail({ id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.processing_status).toBe(VideoProcessingStatus.UPLOADING);
  });

  it('should persist size_bytes above 2^31 without loss', async () => {
    const channel = await createChannel();
    const tenGiB = 10737418240;
    const { id } = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: tenGiB }),
    );

    const found = await videoRepository.findOneByOrFail({ id });

    expect(found.size_bytes).toBe(tenGiB);
  });

  it('should read duration_seconds back as a number with millisecond precision', async () => {
    const channel = await createChannel();
    const { id } = await videoRepository.save(
      buildVideo(channel.id, { duration_seconds: 3723.456 }),
    );

    const found = await videoRepository.findOneByOrFail({ id });

    expect(found.duration_seconds).toBe(3723.456);
  });

  it('should delete the videos of a channel when the channel is removed', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id));

    await channelRepository.delete({ id: channel.id });

    expect(await videoRepository.countBy({ channel_id: channel.id })).toBe(0);
  });
});
