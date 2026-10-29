import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
} from '@nestjs/common';
import { z } from 'zod';

import { Throttle } from '../../../base';
import { CurrentUser } from '../../../core/auth';
import { ChatgptService } from './service';

const commandSchema = z
  .object({
    action: z.enum(['refreshModels', 'select', 'disable', 'disconnect']),
    profileId: z.string().uuid(),
    model: z.string().min(1).max(256).optional(),
  })
  .strict();

@Throttle()
@Controller('/api/copilot/chatgpt')
export class ChatgptController {
  constructor(private readonly chatgpt: ChatgptService) {}

  @Get()
  async status(@CurrentUser() user: CurrentUser) {
    return await this.chatgpt.status(user.id);
  }

  @Post()
  async update(@CurrentUser() user: CurrentUser, @Body() body: unknown) {
    const parsed = commandSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Invalid ChatGPT operation');
    return await this.chatgpt.command(user.id, parsed.data);
  }
}
