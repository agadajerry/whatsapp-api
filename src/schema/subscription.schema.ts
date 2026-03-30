import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class Subscription {
  @Prop({
    enum: ['free', 'basic', 'pro', 'enterprise'],
    default: 'free',
  })
  plan: string;

  @Prop({ default: 3 })
  maxSessions: number;

  @Prop()
  expiresAt: Date;
}

export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);
