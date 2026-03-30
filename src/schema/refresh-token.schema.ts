import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";

@Schema()
export class RefreshToken {
  @Prop({ required: true, type: 'ObjectId', ref: 'User' })
  userId: string;

  @Prop({ required: true })
  token: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken); 