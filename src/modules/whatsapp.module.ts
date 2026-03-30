import { Module } from '@nestjs/common';
import { WebhookService } from '../services/webhook.service';
import { MessageController } from '../controllers/message.controller';
import { SessionService } from '../services/session.service';
import { DatabaseModule } from './database.module';
import { AuthModule } from './auth.module';
import { WhatsAppController } from 'src/controllers/whatsapp.controller';
import { HttpModule } from '@nestjs/axios';
import { SessionGateway } from 'src/ws/session-gateway';
import { JwtModule, JwtService } from '@nestjs/jwt';

@Module({
  imports: [DatabaseModule,HttpModule],
  controllers: [WhatsAppController, MessageController],
  providers: [SessionService, WebhookService,SessionGateway,JwtService],
  exports: [SessionService],
})
export class WhatsAppModule {}
