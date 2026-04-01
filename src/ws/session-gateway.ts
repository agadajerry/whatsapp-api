import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';

interface JwtPayload {
  sub: string; // userId
  clientId?: string;
}

@WebSocketGateway({
  namespace: '/chat-connect',
  cors: {
    origin: '*',
  },
  // Add ping timeout to detect dead connections
  pingTimeout: 60000,
  pingInterval: 25000,
   transports: ['websocket'],
})
export class SessionGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SessionGateway.name);

  constructor(private readonly jwtService: JwtService) {}

  /* ------------------------------------------------------
     SOCKET CONNECTION (JWT AUTH)
  ------------------------------------------------------ */

  async handleConnection(socket: Socket) {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn(`Socket ${socket.id}: missing token`);
        socket.emit('auth_error', { message: 'Missing authentication token' });
        socket.disconnect();
        return;
      }

      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: process.env.JWT_SECRET, // Make sure to specify secret
      });

      if (!payload?.sub) {
        this.logger.warn(`Socket ${socket.id}: invalid token payload`);
        socket.emit('auth_error', { message: 'Invalid token' });
        socket.disconnect();
        return;
      }

      // Join user-scoped room
      socket.join(`user:${payload.sub}`);
      socket.data.userId = payload.sub;

      this.logger.log(`✓ Socket ${socket.id} connected → user:${payload.sub}`);

      // Notify client of successful authentication
      socket.emit('auth_success', { userId: payload.sub });
    } catch (error) {
      this.logger.error(
        `Socket ${socket.id} authentication failed: ${error.message}`,
      );

      // Send specific error to client
      if (error.name === 'TokenExpiredError') {
        socket.emit('auth_error', {
          message: 'Token expired',
          code: 'TOKEN_EXPIRED',
        });
      } else if (error.name === 'JsonWebTokenError') {
        socket.emit('auth_error', {
          message: 'Invalid token',
          code: 'INVALID_TOKEN',
        });
      } else {
        socket.emit('auth_error', { message: 'Authentication failed' });
      }

      socket.disconnect();
    }
  }

  handleDisconnect(socket: Socket) {
    const userId = socket.data?.userId;
    this.logger.log(
      `✗ Socket ${socket.id} disconnected${userId ? ` → user:${userId}` : ''}`,
    );
  }

  /* ------------------------------------------------------
     EMIT HELPERS (MATCH FRONTEND EVENTS)
  ------------------------------------------------------ */

  emitSessionQr(userId: string, sessionId: string, qr: string) {
    this.emitToUser(userId, 'session:qr', { sessionId, qr });
  }

  emitSessionReady(userId: string, sessionId: string, phoneNumber: string) {
    this.server.to(`user:${userId}`).emit('session.ready', {
      sessionId,
      phoneNumber,
    });
  }

  emitSessionDisconnected(userId: string, sessionId: string) {
    this.server.to(`user:${userId}`).emit('session.disconnected', {
      sessionId,
    });
  }

  emitToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  emitAuthFailure(userId: string, sessionId: string) {
    this.server.to(`user:${userId}`).emit('session.auth_failure', {
      sessionId,
    });
  }

  emitMessageSent(userId: string, sessionId: string, messageId: string) {
    this.server.to(`user:${userId}`).emit('message.sent', {
      sessionId,
      messageId,
    });
  }

  emitMessageDelivered(
    userId: string,
    sessionId: string,
    messageId: string,
    status: 'sent' | 'delivered' | 'read',
  ) {
    this.server.to(`user:${userId}`).emit('message.delivered', {
      sessionId,
      messageId,
      status,
    });
  }

  emitIncomingMessage(userId: string, sessionId: string, message: any) {
    this.server.to(`user:${userId}`).emit('message.received', {
      sessionId,
      message,
    });
  }

  
}
