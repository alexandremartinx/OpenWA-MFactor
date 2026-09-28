import { ApiProperty } from '@nestjs/swagger';
import { Expose, plainToInstance } from 'class-transformer';
import { AiBotChat } from './ai-bot-chat.entity';

export class AiBotChatResponseDto {
  @ApiProperty()
  @Expose()
  id!: string;

  @ApiProperty()
  @Expose()
  sessionId!: string;

  @ApiProperty({ example: '5511999999999@c.us' })
  @Expose()
  chatId!: string;

  @ApiProperty({ nullable: true, type: String, description: 'How the person asked to be called.' })
  @Expose()
  customerName!: string | null;

  @ApiProperty({
    nullable: true,
    type: Date,
    description: "Assistant's first message in the chat; operator messages after it silence the assistant.",
  })
  @Expose()
  firstReplyAt!: Date | null;

  @ApiProperty({
    nullable: true,
    type: Date,
    description: "When the sales follow-up to the contact's automatic business greeting was sent.",
  })
  @Expose()
  followUpSentAt!: Date | null;

  @ApiProperty({ nullable: true, type: Date, description: 'When the assistant introduced itself to a real person.' })
  @Expose()
  introducedAt!: Date | null;

  @ApiProperty({
    nullable: true,
    type: Date,
    description: 'Set while the chat belongs to a human; the assistant is silent.',
  })
  @Expose()
  handoffAt!: Date | null;

  @ApiProperty({ nullable: true, type: String })
  @Expose()
  handoffReason!: string | null;

  @ApiProperty()
  @Expose()
  createdAt!: Date;

  @ApiProperty()
  @Expose()
  updatedAt!: Date;

  static fromEntity(chat: AiBotChat): AiBotChatResponseDto {
    return plainToInstance(AiBotChatResponseDto, chat, { excludeExtraneousValues: true });
  }
}
