import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class SendMessageDto {

  @ApiProperty({
    description: "The recipient's phone number",
    example: '+1234567890',
  })
  @IsString()
  @IsNotEmpty()
  to: string;

  @ApiProperty({
    description: 'The text message to send',
    example: 'Hello from WhatsApp API!',
  })
  @IsString()
  @IsNotEmpty()
  message: string;
}

export class SendAttachmentDto {
  @ApiPropertyOptional({
    description: 'Session API Key (can also be passed in header)',
  })
  @IsOptional()
  @IsString()
  'X-API-KEY'?: string;

  @ApiProperty({
    description: "The recipient's phone number",
    example: '+1234567890',
  })
  @IsString()
  @IsNotEmpty()
  to: string;

  @ApiPropertyOptional({
    description: 'A public URL to the file or a Base64 encoded string',
    example: 'https://example.com/image.jpg',
  })
  @IsOptional()
  @IsString()
  file?: string;

  @ApiPropertyOptional({
    description: 'The MIME type of the file (required for Base64)',
    example: 'image/jpeg',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({
    description: 'Caption for the attachment',
    example: 'Check out this image!',
  })
  @IsOptional()
  @IsString()
  caption: string;
}

export class SendQueryDto {
  @ApiProperty({
    description: "The recipient's phone number",
    example: '+1234567890',
  })
  @IsString()
  @IsNotEmpty()
  number: string;

  @ApiPropertyOptional({
    description:
      'The text message to send (used as caption if attachmentUrl is present)',
    example: 'Hello!',
  })
  @IsOptional()
  @IsString()
  message: string;

  @ApiPropertyOptional({
    description: 'A URL to a file to send as an attachment',
    example: 'https://example.com/document.pdf',
  })
  @IsOptional()
  @IsString()
  attachmentUrl?: string;
}
