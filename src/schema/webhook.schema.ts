import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type WebhookDocument = Webhook & Document;

@Schema({ timestamps: true })
export class Webhook {
  @Prop({ required: true })
  clientId: string;

  @Prop({ required: true })
  url: string;

  @Prop({ default: true })
  enabled: boolean;

  @Prop({ default: [] })
  events: string[];

  @Prop()
  secret?: string;
}

export const WebhookSchema = SchemaFactory.createForClass(Webhook);