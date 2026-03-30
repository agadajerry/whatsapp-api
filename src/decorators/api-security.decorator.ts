import { applyDecorators } from '@nestjs/common';
import { ApiSecurity, ApiHeader } from '@nestjs/swagger';


export function ApiSessionKey() {
  return applyDecorators(
    ApiSecurity('session-key'),
    ApiHeader({
      name: 'X-API-KEY',
      description: 'Session-specific API Key',
      required: true,
    }),
  );
}
