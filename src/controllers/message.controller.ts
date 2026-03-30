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
import { SessionService } from '../services/session.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { Request } from 'express';

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

  @Post('send-attachment')
  @ApiOperation({ summary: 'Send a message with an attachment' })
  @ApiSessionKey()
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        'X-API-KEY': { type: 'string' },
        to: { type: 'string' },
        caption: { type: 'string' },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Attachment sent successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @UseInterceptors(FileInterceptor('file'))
  async sendAttachmentMessage(
    @SessionId() sessionId: string,
    @Body() dto: SendAttachmentDto,
    @UploadedFile() uploadedFile?: Express.Multer.File,
  ) {
    let filePath: string | any;

    try {
      // 1️⃣ Resolve file source
      if (uploadedFile) {
        filePath = uploadedFile.path;
      } else if (dto.file) {
        filePath = dto.file;
      } else {
        throw new HttpException(
          'Missing "file" (upload or body)',
          HttpStatus.BAD_REQUEST,
        );
      }

      // 2️⃣ Send attachment
      await this.sessionService.sendAttachment(
        sessionId,
        dto.to,
        filePath,
        dto.caption,
        dto.type,
      );

      return {
        success: true,
        message: uploadedFile
          ? 'Attachment sent successfully from uploaded file.'
          : 'Attachment sent successfully from URL/Base64.',
      };
    } catch (error) {
      this.logger.error(`[${sessionId}] Failed to send attachment`, error);

      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    } finally {
      // 3️⃣ Cleanup only uploaded files
      if (uploadedFile && filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (cleanupError) {
          this.logger.warn(
            `[${sessionId}] Failed to cleanup temp file: ${filePath}`,
            cleanupError,
          );
        }
      }
    }
  }

  @Get('send')
  @ApiOperation({ summary: 'Send a message via GET request' })
  @ApiSessionKey()
  @ApiResponse({ status: 200, description: 'Message sent successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async sendFromApi(
    @SessionId() sessionId: string,
    @Query() query: SendQueryDto,
  ) {
    if (!query.number || (!query.message && !query.attachmentUrl)) {
      throw new HttpException(
        'Missing required query parameters: number and either message or attachmentUrl',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      if (query.attachmentUrl) {
        await this.sessionService.sendAttachment(
          sessionId,
          query.number,
          query.attachmentUrl,
          query.message || '',
        );
        return { success: true, message: 'Attachment sent successfully.' };
      } else {
        await this.sessionService.sendMessage(
          sessionId,
          query.number,
          query.message,
        );
        return { success: true, message: 'Message sent successfully.' };
      }
    } catch (error) {
      this.logger.error(
        `[${sessionId}] Failed to send message via GET API:`,
        error,
      );
      throw new HttpException(
        { success: false, error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
