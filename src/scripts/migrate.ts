import dotenv from 'dotenv';
import { runner } from 'node-pg-migrate';

dotenv.config();

export async function run() {
  const direction = process.env.MIGRATION_DIRECTION as 'up' | 'down' | undefined || 'up';
  try {
  await runner({
      direction,
      migrationsTable: process.env.MIGRATIONS_TABLE || 'pgmigrations',
      dir: 'migrations',
      verbose: true,
      databaseUrl: {
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
      }
    });
    console.log(`✅ Migrations ${direction} completed`);
  } catch (err) {
    console.error('❌ Migration error:', err);
    process.exit(1);
  }
}