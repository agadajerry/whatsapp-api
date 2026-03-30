import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Session {
  @Prop({ required: true, index: true })
  sessionId: string;

  @Prop({ required: true })
  userId: Types.ObjectId;

  @Prop({ default: 'Initializing' })
  status: string;

  @Prop({ type: String, default: null })
  qrCode: string | null;
  
  @Prop()
  phoneNumber?: string;

  @Prop({ type: Boolean, default: false })
  isAuthenticated: boolean;
}

export type SessionDocument = Session & Document;
export const SessionSchema = SchemaFactory.createForClass(Session);
