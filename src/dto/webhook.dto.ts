import {
  IsBoolean,
  IsOptional,
  IsString,
  IsArray,
  IsUrl,
} from 'class-validator';

export class WebhookDto {
  @IsUrl()
  url: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsString()
  secret?: string;
}
