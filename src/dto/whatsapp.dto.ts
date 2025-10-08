import { IsString, IsOptional, IsArray, IsBoolean, IsUrl } from 'class-validator';

export class SendMessageDto {
  @IsString()
  to: string;

  @IsString()
  message: string;

  @IsOptional()
  @IsString()
  type?: 'text' | 'image' | 'document';
}


export class CreateSessionDto {
  @IsString()
  clientId: string;

  @IsOptional()
  @IsString()
  webhook?: string;
}

export class WebhookConfigDto {
  @IsUrl()
  url: string;

  @IsOptional()
  @IsArray()
  events?: string[];

  @IsOptional()
  @IsString()
  secret?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}