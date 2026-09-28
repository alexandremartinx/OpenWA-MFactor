import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `ai_bot_chats` — the AI assistant's per-chat state (recorded name, which framing it has
 * used, handoff). One row per (session, chat). CASCADE FK to sessions, like `automation_rules`: the
 * state has no meaning after its session is gone. Date columns are `text` on SQLite, as every
 * `dateColumnType()` column is. Hand-authored because `synchronize` is off on the `data` connection
 * for Postgres (and optional on SQLite).
 */
export class AddAiBotChats1786500000000 implements MigrationInterface {
  name = 'AddAiBotChats1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('ai_bot_chats')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "ai_bot_chats" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"sessionId" varchar NOT NULL, "chatId" varchar NOT NULL, "customerName" varchar(100), ` +
          `"firstReplyAt" timestamp, "followUpSentAt" timestamp, "introducedAt" timestamp, "handoffAt" timestamp, ` +
          `"handoffReason" varchar(300), ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `CONSTRAINT "FK_ai_bot_chats_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "ai_bot_chats" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionId" varchar NOT NULL, "chatId" varchar NOT NULL, "customerName" varchar(100), ` +
          `"firstReplyAt" text, "followUpSentAt" text, "introducedAt" text, "handoffAt" text, ` +
          `"handoffReason" varchar(300), ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `CONSTRAINT "FK_ai_bot_chats_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_ai_bot_chats_sessionId_chatId" ON "ai_bot_chats" ("sessionId", "chatId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so revert is idempotent on a synchronize-bootstrapped DB, where this migration was
    // recorded via the up() hasTable early-return and the named index was never created.
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_ai_bot_chats_sessionId_chatId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_bot_chats"`);
  }
}
