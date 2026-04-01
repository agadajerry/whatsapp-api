import {
  Controller,
  Get,
  UseGuards,
  Req,
  HttpStatus,
  Res,
  Post,
  Body,
  Param,
  Delete,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { SessionService } from 'src/services/session.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { WebhookService } from 'src/services/webhook.service';
import { WebhookDto } from 'src/dto/webhook.dto';

@ApiTags('Authentication')
@Controller('api')
export class WhatsAppController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly webhook: WebhookService,
  ) {}

  /**
   * ---------------------------------------------
   * Initialize WhatsApp Session
   * ---------------------------------------------
   * - Triggers session creation
   * - QR is emitted via WebSocket (session.qr)
   */
  @UseGuards(JwtAuthGuard)
  @Get('connect')
  @ApiOperation({ summary: 'Initialize WhatsApp session' })
  @ApiResponse({
    status: 200,
    description: 'Session initialization started',
  })
  async connect(@Req() req: any, @Res() res: Response) {
    const userId = req.user.sub;
    const clientId = req.user.clientId;
    console.log(clientId)

    await this.sessionService.initializeClient(clientId, userId);

    return res.status(HttpStatus.OK).json({
      clientId,
      status: 'INITIALIZING',
      message: 'Session initialization started. Await QR via socket.',
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post('session/disconnect')
  @ApiOperation({ summary: 'Disconnect WhatsApp session' })
  @ApiResponse({
    status: 200,
    description: 'Session disconnected successfully',
  })
  async disconnect(@Req() req: any) {
    const clientId = req.user.clientId;

    await this.sessionService.disconnectClient(clientId);

    return {
      clientId,
      status: 'DISCONNECTED',
      message: 'Session disconnected successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('session')
  @ApiOperation({ summary: 'Delete entire WhatsApp session' })
  @ApiResponse({
    status: 200,
    description: 'Session deleted successfully',
  })
  async deleteSession(@Req() req: any) {
    const clientId = req.user.clientId;

    console.log(clientId,"I am here")

    await this.sessionService.deleteSession(clientId);

    return {
      clientId,
      status: 'DELETED',
      message: 'Session deleted successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  @ApiOperation({ summary: 'Get all user sessions' })
  @ApiResponse({
    status: 200,
    description: 'Session gotten successfully',
  })
  async getAllUserSession(@Req() req: any) {
    const userID = req.user.sub;

    const userSessions = await this.sessionService.getAllSessions(userID);

    return userSessions;
  }

  @UseGuards(JwtAuthGuard)
  @Post('webhook')
  @ApiOperation({ summary: 'Insert webhook url' })
  @ApiResponse({
    status: 200,
    description: 'Webhook for the given phone number inserted successfully...',
  })
  async insertWebhook(@Req() req: any, @Body() payload: WebhookDto) {
    const clientId = req.user.clientId;
    payload.secret = req.user.apiKey;
    return await this.webhook.createWebhook(clientId, payload);
  }

  @UseGuards(JwtAuthGuard)
  @Get('webhook')
  @ApiOperation({ summary: 'Get webhook url' })
  @ApiResponse({
    status: 200,
    description: 'Webhook for the given phone number returned successfully...',
  })
  async getWebhook(@Req() req: any) {
    const clientId = req.user.clientId;
    return await this.webhook.getWebhook(clientId);
  }

  @Post('/test/webhook')
  testWebhook(@Req() req: Request, @Body() payload: any) {
    console.log(req.headers);
    console.log(payload);
  }

  /**
   * ---------------------------------------------
   * Identity Check (unchanged)
   * ---------------------------------------------
   */
  @UseGuards(JwtAuthGuard)
  @Get('whoami')
  whoAmI(@Req() req: any) {
    return {
      hasUser: !!req.user,
      user: req.user ?? null,
    };
  }
}
