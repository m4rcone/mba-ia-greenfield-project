import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1792296841235 } from './migrations/1792296841235-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

const MANAGED_ENUMS = [
  'verification_tokens_type_enum',
  'video_status',
  'video_processing_status',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1792296841235,
        ],
      },
    );

    await dataSource.initialize();

    // Sequential on purpose: concurrent DROP ... CASCADE on FK-related tables deadlocks.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    // DROP TABLE does not remove enum types; suites using synchronize may have created them.
    for (const enumName of MANAGED_ENUMS) {
      await dataSource.query(
        `DROP TYPE IF EXISTS "public"."${enumName}" CASCADE`,
      );
    }
  });

  afterAll(async () => {
    // The revert test undoes the last migration, leaving the videos table missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all managed tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should create the videos enums, channel FK and indexes', async () => {
    const enums = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type
       WHERE typname = ANY($1::text[])
       ORDER BY typname`,
      [['video_processing_status', 'video_status']],
    );
    expect(enums.map((e) => e.typname)).toEqual([
      'video_processing_status',
      'video_status',
    ]);

    const fk = await dataSource.query<{ confdeltype: string }[]>(
      `SELECT c.confdeltype FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.conrelid = 'videos'::regclass
         AND c.confrelid = 'channels'::regclass`,
    );
    // 'c' = ON DELETE CASCADE
    expect(fk).toEqual([{ confdeltype: 'c' }]);

    const indexes = await dataSource.query<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'videos'`,
    );
    const defs = indexes.map((i) => i.indexdef);
    expect(defs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/UNIQUE INDEX .*\(public_id\)/),
        expect.stringMatching(/INDEX .*\(channel_id\)/),
        expect.stringMatching(/INDEX .*\(processing_status, updated_at\)/),
      ]),
    );
  });

  it('should revert the last migration and remove the videos table and enums', async () => {
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    expect(tables).toHaveLength(0);

    const enums = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = ANY($1::text[])`,
      [['video_processing_status', 'video_status']],
    );
    expect(enums).toHaveLength(0);
  });
});
