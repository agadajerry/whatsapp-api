import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Message, MessageSchema } from 'src/schema/message.schema';
import { RefreshToken, RefreshTokenSchema } from 'src/schema/refresh-token.schema';
import { Session, SessionSchema } from 'src/schema/session.schema';
import { Subscription, SubscriptionSchema } from 'src/schema/subscription.schema';
import { User, UserSchema } from 'src/schema/user.schema';
import { Webhook, WebhookSchema } from 'src/schema/webhook.schema';


@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Webhook.name, schema: WebhookSchema },
      // { name: User.name, schema: UserSchema },
      // { name: RefreshToken.name, schema: RefreshTokenSchema },
      // { name: Subscription.name, schema: SubscriptionSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {} 
