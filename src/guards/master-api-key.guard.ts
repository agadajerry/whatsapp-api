import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

@Injectable()
export class MasterApiKeyGuard implements CanActivate {
  constructor(
    private configService: ConfigService,
    private reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const masterKey =
      request.headers['x-master-key'] || request.body?.['X-MASTER-KEY'];

    const expectedKey = this.configService.get<string>('MASTER_API_KEY', 'idoko400');

    if (!expectedKey) {
      throw new UnauthorizedException('Server configuration error.');
    }

    if (!masterKey || masterKey !== expectedKey) {
      throw new UnauthorizedException('Missing or invalid Master API key.');
    }

    return true;
  }
}