import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SessionDocument = Session & Document;

@Schema({ timestamps: true })
export class Session {
  @Prop({ required: true, unique: true })
  clientId: string;

  @Prop()
  phoneNumber?: string;

  @Prop({ default: 'disconnected' })
  status: 'connecting' | 'connected' | 'disconnected' | 'qr_required';

  @Prop()
  lastActivity: Date;

  @Prop()
  qrCode?: string;

  @Prop({ default: 0 })
  messageCount: number;

  @Prop({ type: Object })
  metadata?: any;
}

export const SessionSchema = SchemaFactory.createForClass(Session);
