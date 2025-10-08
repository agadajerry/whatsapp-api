import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { WhatsAppService } from './whatsapp.service';

@WebSocketGateway({
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
})
export class WhatsAppGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private connectedUsers: Map<string, string> = new Map();

  constructor(private readonly whatsAppService: WhatsAppService) {}

  afterInit() {
    console.log('WebSocket initialized');
  }

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    const clientId = this.connectedUsers.get(client.id);
    if (clientId) {
      console.log(`Client ${clientId} disconnected from WebSocket`);
    }
    this.connectedUsers.delete(client.id);
  }

  @SubscribeMessage('start-session')
  async startSession(
    @MessageBody() data: { clientId: string },
    @ConnectedSocket() clientSocket: Socket,
  ) {
    const { clientId } = data;
    this.connectedUsers.set(clientSocket.id, clientId);

    try {
      const result = await this.whatsAppService.initSession(clientId);
      clientSocket.emit('session-status', { clientId, ...result });

      // Send QR if available
      const status = await this.whatsAppService.getSessionStatus(clientId);
      if (status.qrCode) {
        clientSocket.emit('qr', { clientId, qr: status.qrCode });
      }
    } catch (error) {
      clientSocket.emit('error', { clientId, error: error.message });
    }
  }

  @SubscribeMessage('get-status')
  async getStatus(
    @MessageBody() data: { clientId: string },
    @ConnectedSocket() clientSocket: Socket,
  ) {
    const status = await this.whatsAppService.getSessionStatus(data.clientId);
    clientSocket.emit('session-status', status);
  }

  @SubscribeMessage('send-message')
  async sendMessage(
    @MessageBody() data: { clientId: string; to: string; message: string },
    @ConnectedSocket() clientSocket: Socket,
  ) {
    try {
      const result = await this.whatsAppService.sendMessage(
        data.clientId,
        data.to,
        data.message,
      );
      clientSocket.emit('message-sent', result);
    } catch (error) {
      clientSocket.emit('error', { 
        clientId: data.clientId, 
        error: error.message 
      });
    }
  }
}