import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole } from '../../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../../auth/entities/api-key.entity';
import { AiBotService } from './ai-bot.service';
import { AiBotChatResponseDto } from './ai-bot-chat.dto';

@ApiTags('automation')
@Controller('sessions/:sessionId/automation/ai-bot/chats')
export class AiBotController {
  constructor(private readonly aiBot: AiBotService) {}

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List the AI assistant’s per-chat state' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'One entry per chat the assistant has acted in, most recently active first.',
    type: AiBotChatResponseDto,
    isArray: true,
  })
  async findAll(@Param('sessionId') sessionId: string): Promise<AiBotChatResponseDto[]> {
    return (await this.aiBot.listChats(sessionId)).map(chat => AiBotChatResponseDto.fromEntity(chat));
  }

  @Post(':chatId/resume')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Give a handed-off chat back to the AI assistant' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID, e.g. 5511999999999@c.us' })
  @ApiResponse({
    status: 200,
    description: 'Handoff cleared; the assistant answers again.',
    type: AiBotChatResponseDto,
  })
  @ApiResponse({ status: 404, description: 'The assistant has no state for this chat in this session.' })
  async resume(@Param('sessionId') sessionId: string, @Param('chatId') chatId: string): Promise<AiBotChatResponseDto> {
    return AiBotChatResponseDto.fromEntity(await this.aiBot.resumeChat(sessionId, chatId));
  }
}
