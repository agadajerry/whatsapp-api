import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { Injectable } from '@nestjs/common';
import * as dotenv from 'dotenv';
dotenv.config();

@Injectable()
export class RefreshTokenStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        RefreshTokenStrategy.extractJWTFromCookie,
      ]),
      ignoreExpiration: false,
      secretOrKey: process.env.REFRESH_TOKEN_SECRET,
      passReqToCallback: true,
    });
  }
  private static extractJWTFromCookie(req: Request): string | null {
    if (!req || !req.cookies) {
      return null;
    }
    try {
      return req.cookies?.refreshToken?.tokens?.refreshToken || null;
    } catch (err) {
      return null;
    }
  }
  validate(req: Request, payload: any) {
    const refreshToken = req.cookies.refreshToken.tokens.refreshToken;
    return { ...payload, refreshToken };
  }
}
