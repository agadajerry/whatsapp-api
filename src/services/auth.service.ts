import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { User, UserDocument } from 'src/schema/user.schema';
import { RefreshToken } from 'src/schema/refresh-token.schema';
import {
  GoogleAuthDto,
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
} from 'src/dto/auth.dto';

@Injectable()
export class AuthService {
  private googleClient: OAuth2Client;

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(RefreshToken.name)
    private refreshTokenModel: Model<RefreshToken>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {
    this.googleClient = new OAuth2Client(
      this.configService.get<string>('GOOGLE_CLIENT_ID'),
    );
  }

  // Generate unique API Key
  private generateApiKey(): string {
    return 'sk_' + crypto.randomBytes(32).toString('hex');
  }

  // Generate Client ID from email
  private generateClientId(email: string): string {
    const username = email.split('@')[0];
    const timestamp = Date.now();
    return `client_${username}_${timestamp}`;
  }

  // Generate JWT tokens
  private generateTokens(
    userId: string,
    email: string,
    clientId: string,
    apiKey: string,
  ) {
    const payload = {
      sub: userId,
      email,
      clientId,
      apiKey,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: '15m',
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: '7d',
    });

    return { accessToken, refreshToken };
  }

  // Register with email/password
  async register(registerDto: RegisterDto) {
    const { email, password, name } = registerDto;

    // Check if user exists
    const existingUser = await this.userModel.findOne({ email });
    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate credentials
    const clientId = this.generateClientId(email);
    const apiKey = this.generateApiKey();

    console.log(apiKey);

    // Create user
    const user = await this.userModel.create({
      email,
      password: hashedPassword,
      name,
      clientId,
      apiKey,
      subscription: {
        plan: 'free',
        maxSessions: 3,
      },
    });

    // Generate tokens
    const { accessToken, refreshToken } = this.generateTokens(
      user._id.toString(),
      user.email,
      user.clientId,
      user.apiKey,
    );

    // Save refresh token
    await this.refreshTokenModel.create({
      userId: user._id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    return {
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        clientId: user.clientId,
        apiKey: user.apiKey,
        subscription: user.subscription,
      },
      accessToken,
      refreshToken,
    };
  }

  // Login with email/password
  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    // Find user
    const user = await this.userModel.findOne({ email });
    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check if account is active
    if (!user.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Generate tokens
    const { accessToken, refreshToken } = this.generateTokens(
      user._id.toString(),
      user.email,
      user.clientId,
      user.apiKey,
    );

    // Delete old refresh tokens and save new one
    await this.refreshTokenModel.deleteMany({ userId: user._id });
    await this.refreshTokenModel.create({
      userId: user._id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    return {
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        clientId: user.clientId,
        apiKey: user.apiKey,
        subscription: user.subscription,
      },
      accessToken,
      refreshToken,
    };
  }

  // Google Sign-In
  async googleAuth(googleAuthDto: GoogleAuthDto) {
    try {
      // Verify Google token
      const ticket = await this.googleClient.verifyIdToken({
        idToken: googleAuthDto.token,
        audience: this.configService.get<string>('GOOGLE_CLIENT_ID'),
      });

      const payload: any = ticket.getPayload();
      if (!payload) {
        throw new BadRequestException('Invalid Google token');
      }

      const { sub: googleId, email, name, picture } = payload;

      // Find or create user
      let user = await this.userModel.findOne({
        $or: [{ googleId }, { email }],
      });

      if (!user) {
        // Create new user
        const clientId = this.generateClientId(email);
        const apiKey = this.generateApiKey();

        user = await this.userModel.create({
          email,
          googleId,
          name,
          picture,
          clientId,
          apiKey,
          subscription: {
            plan: 'free',
            maxSessions: 3,
          },
        });
      } else if (!user.googleId) {
        // Link Google account to existing user
        user.googleId = googleId;
        user.name = name || user.name;
        user.picture = picture || user.picture;
        await user.save();
      }

      // Check if account is active
      if (!user.isActive) {
        throw new UnauthorizedException('Account is deactivated');
      }

      // Generate tokens
      const { accessToken, refreshToken } = this.generateTokens(
        user._id.toString(),
        user.email,
        user.clientId,
        user.apiKey,
      );

      // Save refresh token
      await this.refreshTokenModel.deleteMany({ userId: user._id });
      await this.refreshTokenModel.create({
        userId: user._id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      return {
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          picture: user.picture,
          clientId: user.clientId,
          apiKey: user.apiKey,
          subscription: user.subscription,
        },
        accessToken,
        refreshToken,
      };
    } catch (error) {
      throw new BadRequestException('Google authentication failed');
    }
  }

  // Refresh access token
  async refreshAccessToken(refreshTokenDto: RefreshTokenDto) {
    const { refreshToken } = refreshTokenDto;

    try {
      // Verify refresh token
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });

      // Check if refresh token exists in database
      const storedToken = await this.refreshTokenModel.findOne({
        userId: payload.sub,
        token: refreshToken,
      });

      if (!storedToken || storedToken.expiresAt < new Date()) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      // Get user
      const user = await this.userModel.findById(payload.sub);
      if (!user || !user.isActive) {
        throw new UnauthorizedException('User not found or inactive');
      }

      // Generate new tokens
      const tokens = this.generateTokens(
        user._id.toString(),
        user.email,
        user.clientId,
        user.apiKey,
      );

      // Update refresh token in database
      await this.refreshTokenModel.updateOne(
        { _id: storedToken._id },
        {
          token: tokens.refreshToken,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      );

      return tokens;
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  // Logout
  async logout(userId: string) {
    await this.refreshTokenModel.deleteMany({ userId });
    return { message: 'Logged out successfully' };
  }

  // Validate user by API key (for WhatsApp API requests)

  async validateUser(email: string, password: string): Promise<any> {
    const user = await this.userModel.findOne({ email, isActive: true });
    // console.log(user);
    if (user) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (isMatch) return { user };
    }
    return null;
  }

  // Get user profile
  async getProfile(userId: string) {
    const user = await this.userModel.findById(userId).select('-password');
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return user;
  }

  // Regenerate API key
  async regenerateApiKey(userId: string) {
    const newApiKey = this.generateApiKey();
    const user = await this.userModel
      .findByIdAndUpdate(userId, { apiKey: newApiKey }, { new: true })
      .select('-password');

    return {
      apiKey: newApiKey,
      user,
    };
  }
}
