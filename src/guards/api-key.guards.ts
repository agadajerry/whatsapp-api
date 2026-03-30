import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();

    const apiKey = req.headers['x-api-key'];
    const clientId = req.headers['x-client-id'];

    if (!apiKey || !clientId) {
      throw new UnauthorizedException('Missing API credentials');
    }

    // TODO: Validate against DB
    return true;
  }
}
