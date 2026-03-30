import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Subscription } from './subscription.schema';
import { Session, SessionSchema } from './session.schema';
import { Types } from 'mongoose';

export type UserDocument = User & Document;

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop()
  password: string;

  @Prop({ unique: true, sparse: true })
  googleId: string;

  @Prop({ required: true, unique: true, index: true })
  clientId: string;

  @Prop({ required: true, unique: true, index: true })
  apiKey: string;

  @Prop()
  name: string;

  @Prop()
  picture: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ type: [{ type: Types.ObjectId, ref: Session.name }] })
  sessions: Types.ObjectId[];

  @Prop({ type: Subscription, default: {} })
  subscription: Subscription;

  @Prop()
  refreshToken: string;
}

export const UserSchema = SchemaFactory.createForClass(User); 
