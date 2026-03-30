import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MessageDocument = Message &
  Document & {
    createdAt: Date;
    updatedAt: Date;
  };

@Schema({ timestamps: true })
export class Message {
  @Prop({ required: true })
  clientId: string;

  @Prop({ required: true })
  messageId: string;

  @Prop({ required: true })
  from: string;

  @Prop({ required: true })
  to: string;

  @Prop({ required: true })
  body: string;

  @Prop({ default: 'text' })
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'chat';

  @Prop({ default: 'sent' })
  status: 'sent' | 'delivered' | 'read' | 'failed';

  @Prop({ default: 'outgoing' })
  direction: 'incoming' | 'outgoing';

  @Prop({ type: Object })
  metadata?: any;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

