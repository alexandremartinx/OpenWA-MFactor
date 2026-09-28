import {
  Entity,
  Column,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * Per-chat state of the LLM assistant. One row per (session, chat) the assistant has acted in.
 *
 * `firstReplyAt` is the baseline of the human-takeover probe: an operator message counts as a
 * takeover only when it is newer than the assistant's first reply. Anything earlier — above all the
 * bulk campaign that opened the conversation, which is persisted `automated = false` like any API
 * send — is the context the assistant was brought in to follow up on, not a human taking over.
 */
@Entity('ai_bot_chats')
@Index('UQ_ai_bot_chats_sessionId_chatId', ['sessionId', 'chatId'], { unique: true })
export class AiBotChat {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // varchar (not uuid) to match sessions.id, same reasoning as automation_rules.sessionId.
  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session?: Session;

  @Column({ type: 'varchar' })
  chatId!: string;

  /** How the person asked to be called, recorded by the assistant's `registrar_nome` tool. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  customerName!: string | null;

  /** First assistant message in the chat; baseline of the human-takeover probe. */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  firstReplyAt!: Date | null;

  /** When the assistant sent its sales follow-up to the contact's automatic (business) greeting. */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  followUpSentAt!: Date | null;

  /** When the assistant identified itself as a virtual assistant to a real person. */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  introducedAt!: Date | null;

  /** Set once the chat belongs to a human; the assistant stays silent until it is cleared. */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  handoffAt!: Date | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  handoffReason!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
