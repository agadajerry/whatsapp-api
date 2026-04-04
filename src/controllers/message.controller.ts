import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpStatus,
  HttpException,
  Logger,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import * as fs from 'fs';
import { MasterApiKeyGuard } from '../guards/master-api-key.guard';
import { ApiSessionKey } from '../decorators/api-security.decorator';
import { SessionId } from '../decorators/session-id.decorator';
import {
  SendAttachmentDto,
  SendMessageDto,
  SendQueryDto,
} from 'src/dto/whatsapp.dto';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { Request } from 'express';
import { SessionService } from 'src/services/session.service';

@ApiTags('Messaging')
@Controller('api')
export class MessageController {
  private readonly logger = new Logger(MessageController.name);

  constructor(private readonly sessionService: SessionService) {}

  @UseGuards(JwtAuthGuard)
  @Post('send-message')
  @ApiOperation({ summary: 'Send a text message' })
  @ApiResponse({ status: 200, description: 'Message sent successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 500, description: 'Failed to send message' })
  async sendTextMessage(
    @Req() req: any,
    @Body() sendMessageDto: SendMessageDto,
  ) {
    const clientId = req.user.clientId; 

    try {
      await this.sessionService.sendMessage(  
        clientId,
        sendMessageDto.to,
        sendMessageDto.message,
      );
      return { success: true, message: 'Message sent successfully.' };
    } catch (error) {
      this.logger.error(`[${clientId}] Failed to send message:`, error);
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

}
