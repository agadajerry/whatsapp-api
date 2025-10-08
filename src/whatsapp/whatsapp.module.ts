import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { WebhookService } from './webhook.service';
import { WhatsAppGateway } from './whatsapp.gateway';
import { DatabaseModule } from 'src/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService, WebhookService, WhatsAppGateway],
})
export class WhatsAppModule {}
