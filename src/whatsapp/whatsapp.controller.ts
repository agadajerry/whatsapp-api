import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  SendMessageDto,
  CreateSessionDto,
  WebhookConfigDto,
} from '../dto/whatsapp.dto';
import { WebhookService } from './webhook.service';
import { WhatsAppService } from './whatsapp.service';

@Controller('api/whatsapp')
export class WhatsAppController {
  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly webhookService: WebhookService,
  ) {}

  @Post('sessions')
  async createSession(@Body() createSessionDto: CreateSessionDto) {
    try {
      const result = await this.whatsAppService.initSession(
        createSessionDto.clientId,
      );

      if (createSessionDto.webhook) {
        await this.webhookService.createWebhook(createSessionDto.clientId, {
          url: createSessionDto.webhook,
          enabled: true,
          events: [],
        });
      }

      return result;
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':clientId/restart')
async restartSession(@Param('clientId') clientId: string) {
  return this.whatsAppService.restartSession(clientId);
}

  @Get('sessions')
  async getAllSessions() {
    return await this.whatsAppService.getAllSessions();
  }

  @Get('sessions/:clientId')
  async getSession(@Param('clientId') clientId: string) {
    return await this.whatsAppService.getSessionStatus(clientId);
  }

  @Delete('sessions/:clientId')
  async deleteSession(@Param('clientId') clientId: string) {
    try {
      return await this.whatsAppService.deleteSession(clientId);
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('sessions/:clientId/messages')
  async sendMessage(
    @Param('clientId') clientId: string,
    @Body() sendMessageDto: SendMessageDto,
  ) {
    try {
      return await this.whatsAppService.sendMessage(
        clientId,
        sendMessageDto.to,
        sendMessageDto.message,
        sendMessageDto.type || 'text',
      );
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Get('sessions/:clientId/messages')
  async getMessages(
    @Param('clientId') clientId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return await this.whatsAppService.getMessages(
      clientId,
      limit || 50,
      offset || 0,
    );
  }

  @Post('sessions/:clientId/webhook')
  async configureWebhook(
    @Param('clientId') clientId: string,
    @Body() webhookConfig: WebhookConfigDto,
  ) {
    return await this.webhookService.createWebhook(clientId, webhookConfig);
  }

  @Get('sessions/:clientId/webhook')
  async getWebhook(@Param('clientId') clientId: string) {
    return await this.webhookService.getWebhook(clientId);
  }

  @Delete('sessions/:clientId/webhook')
  async deleteWebhook(@Param('clientId') clientId: string) {
    return await this.webhookService.deleteWebhook(clientId);
  }

  
}
