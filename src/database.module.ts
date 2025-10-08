import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Session, SessionSchema } from './schema/session.schema';
import { Message, MessageSchema } from './schema/message.schema';
import { Webhook, WebhookSchema } from './schema/webhook.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Webhook.name, schema: WebhookSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {}
