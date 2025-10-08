import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Client, LocalAuth, Message as WAMessage } from 'whatsapp-web.js';
import { WebhookService } from './webhook.service';
import * as QRCode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionDocument } from 'src/schema/session.schema';
import { Message, MessageDocument } from 'src/schema/message.schema';
import { Webhook, WebhookDocument } from 'src/schema/webhook.schema';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private clients: Map<string, Client> = new Map();
  private qrCodes: Map<string, string> = new Map();
  private initializingClients: Set<string> = new Set();
  private readyTimeouts: Map<string, NodeJS.Timeout> = new Map(); // Track ready timeouts

  constructor(
    @InjectModel(Session.name) private sessionModel: Model<SessionDocument>,
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    @InjectModel(Webhook.name) private webhookModel: Model<WebhookDocument>,
    private webhookService: WebhookService,
  ) {
    this.ensureSessionsDirectory();
    this.restoreSessions();
  }

  private ensureSessionsDirectory() {
    const sessionsDir = path.resolve('./wa-sessions');
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o755 });
      this.logger.log('Created wa-sessions directory');
    }
  }

  async restoreSessions() {
    try {
      const sessions = await this.sessionModel.find({ status: 'connected' });
      this.logger.log(`Restoring ${sessions.length} sessions...`);

      for (const session of sessions) {
        await new Promise((resolve) => setTimeout(resolve, 3000)); // Increased delay
        await this.initSession(session.clientId);
      }
    } catch (error) {
      this.logger.error('Failed to restore sessions:', error);
    }
  }

  async initSession(
    clientId: string,
  ): Promise<{ success: boolean; qr?: string; status: string }> {
    try {
      if (this.initializingClients.has(clientId)) {
        this.logger.warn(`Session ${clientId} is already being initialized`);
        return { success: false, status: 'initializing' };
      }

      if (this.clients.has(clientId)) {
        const client = this.clients.get(clientId);
        if (client && client.info) {
          return { success: true, status: 'connected' };
        } else {
          await this.cleanupClient(clientId);
        }
      }

      this.initializingClients.add(clientId);
      await this.updateSessionStatus(clientId, 'connecting');

      this.logger.log(`Initializing session for ${clientId}...`);

      // const client = new Client({
      //   authStrategy: new LocalAuth({
      //     clientId,
      //     dataPath: path.resolve('./wa-sessions'),
      //   }),
      //   puppeteer: {
      //     headless: true,
      //     executablePath: undefined,
      //     args: [
      //       '--no-sandbox',
      //       '--disable-setuid-sandbox',
      //       '--disable-dev-shm-usage',
      //       '--disable-accelerated-2d-canvas',
      //       '--disable-background-timer-throttling',
      //       '--disable-backgrounding-occluded-windows',
      //       '--disable-renderer-backgrounding',
      //       '--no-first-run',
      //       '--no-zygote',
      //       '--disable-gpu',
      //       '--no-crash-upload',
      //       '--disable-web-security',
      //       '--disable-features=VizDisplayCompositor',
      //       '--disable-blink-features=AutomationControlled',
      //     ],
      //     timeout: 60000,
      //   },
      //   webVersionCache: {
      //     type: 'remote',
      //     remotePath:
      //       'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
      //   },
      // });

      // Set up event handlers BEFORE initialization

      const client = new Client({
        authStrategy: new LocalAuth({ clientId }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-plugins',
            '--disable-default-apps',
            '--disable-permissions-policy-warnings',
          ],
          dumpio: false,
        },
      });

      this.setupClientEventHandlers(clientId, client);
      this.clients.set(clientId, client);

      // Initialize with longer timeout and better error handling
      const initPromise = client.initialize();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error('Initialization timeout after 240 seconds')),
          240000,
        );
      });

      await Promise.race([initPromise, timeoutPromise]);

      this.logger.log(`Session ${clientId} initialization completed`);
      return { success: true, status: 'connecting' };
    } catch (error) {
      this.logger.error(`Failed to initialize session ${clientId}:`, error);
      await this.handleInitializationFailure(clientId, error.message);
      return { success: false, status: 'disconnected' };
    } finally {
      this.initializingClients.delete(clientId);
    }
  }

  private setupClientEventHandlers(clientId: string, client: Client) {
    // Clear any existing timeouts
    const existingTimeout = this.readyTimeouts.get(clientId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.readyTimeouts.delete(clientId);
    }

    // QR Code event with rate limiting
    let qrCount = 0;
    client.on('qr', async (qr) => {
      try {
        qrCount++;
        this.logger.log(
          `QR code generated for ${clientId} (attempt ${qrCount})`,
        );

        if (qrCount > 5) {
          this.logger.error(
            `Too many QR codes generated for ${clientId}, stopping`,
          );
          await this.handleInitializationFailure(
            clientId,
            'Too many QR attempts',
          );
          return;
        }

        const qrDataUrl = await QRCode.toDataURL(qr);
        this.qrCodes.set(clientId, qrDataUrl);
        await this.updateSession(clientId, {
          status: 'qr_required',
          qrCode: qrDataUrl,
        });

        await this.webhookService.sendWebhook(clientId, 'qr_code', {
          qr: qrDataUrl,
          attempt: qrCount,
        });
      } catch (error) {
        this.logger.error(`QR generation failed for ${clientId}:`, error);
      }
    });

    // Loading screen event for better debugging
    client.on('loading_screen', (percent, message) => {
      this.logger.log(
        `Loading screen for ${clientId}: ${percent}% - ${message}`,
      );
    });

    // Authenticated event
    client.on('authenticated', async () => {
      this.logger.log(
        `Client ${clientId} authenticated successfully - waiting for ready event...`,
      );
      this.qrCodes.delete(clientId);
      await this.updateSessionStatus(clientId, 'connecting');

      // Set a timeout to handle cases where ready event doesn't fire
      const readyTimeout = setTimeout(async () => {
        this.logger.warn(
          `Ready event timeout for ${clientId} - checking client state manually`,
        );
        await this.handleReadyTimeout(clientId, client);
      }, 60000); // 60 seconds timeout for ready event

      this.readyTimeouts.set(clientId, readyTimeout);
    });

    // Ready event with enhanced error handling
    client.on('ready', async () => {
      try {
        // Clear the ready timeout since we got the event
        const readyTimeout = this.readyTimeouts.get(clientId);
        if (readyTimeout) {
          clearTimeout(readyTimeout);
          this.readyTimeouts.delete(clientId);
        }

        this.logger.log(`Client ${clientId} ready event fired!`);

        // Wait a moment for client.info to be fully populated
        await new Promise((resolve) => setTimeout(resolve, 1000));

        console.log('Client info:', client);

        if (!client.info) {
          this.logger.error(`Client ${clientId} ready but no info available`);
          // Try to get info manually
          try {
            const info = await client.getState();
            this.logger.log(`Manual state check for ${clientId}:`, info);
          } catch (stateError) {
            this.logger.error(
              `Failed to get manual state for ${clientId}:`,
              stateError,
            );
          }
          return;
        }

        const phoneNumber = client.info.wid?.user;
        this.logger.log(
          `Processing ready event for ${clientId} with phone: ${phoneNumber}`,
        );

        await this.updateSession(clientId, {
          status: 'connected',
          phoneNumber,
          lastActivity: new Date(),
          qrCode: undefined,
        });

        this.qrCodes.delete(clientId);
        this.logger.log(
          `Client ${clientId} (${phoneNumber}) is fully ready and connected!`,
        );

        // Send webhook
        await this.webhookService.sendWebhook(clientId, 'ready', {
          phoneNumber,
          clientId,
        });
      } catch (error) {
        this.logger.error(`Error in ready handler for ${clientId}:`, error);
        // Try to continue anyway
        await this.updateSessionStatus(clientId, 'connected');
      }
    });

    // Change state event for better debugging
    client.on('change_state', async (state) => {
      this.logger.log(`Client ${clientId} state changed to: ${state}`);

      // Handle specific states that might indicate readiness
      if (state === 'CONNECTED' || state === 'OPENING') {
        this.logger.log(
          `Client ${clientId} reached state ${state} - checking if ready...`,
        );

        // Small delay then check if we have info
        setTimeout(async () => {
          if (client.info && !this.readyTimeouts.has(clientId)) {
            this.logger.log(
              `Client ${clientId} has info in state ${state} - treating as ready`,
            );
            // Manually trigger ready logic if we have info but ready event didn't fire
            await this.handleManualReady(clientId, client);
          }
        }, 3000);
      }
    });

    // Message event
    client.on('message', async (message: WAMessage) => {
      await this.handleIncomingMessage(clientId, message);
    });

    // Disconnected event
    client.on('disconnected', async (reason) => {
      this.logger.warn(`Client ${clientId} disconnected:`, reason);

      // Clear timeout
      const readyTimeout = this.readyTimeouts.get(clientId);
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        this.readyTimeouts.delete(clientId);
      }

      await this.updateSessionStatus(clientId, 'disconnected');
      this.clients.delete(clientId);
      this.qrCodes.delete(clientId);

      await this.webhookService.sendWebhook(clientId, 'disconnected', {
        reason,
      });
    });

    // Auth failure event
    client.on('auth_failure', async (message) => {
      this.logger.error(`Auth failure for ${clientId}:`, message);
      await this.handleInitializationFailure(
        clientId,
        `Auth failure: ${message}`,
      );
      await this.webhookService.sendWebhook(clientId, 'auth_failure', {
        message,
      });
    });
  }

  // Handle cases where ready event doesn't fire but client is authenticated
  private async handleReadyTimeout(clientId: string, client: Client) {
    try {
      this.logger.log(
        `Handling ready timeout for ${clientId} - checking client state...`,
      );

      // Check if client has info (meaning it's actually ready)
      if (client.info) {
        this.logger.log(
          `Client ${clientId} has info despite no ready event - treating as ready`,
        );
        await this.handleManualReady(clientId, client);
      } else {
        // Try to get state
        try {
          const state = await client.getState();
          this.logger.log(`Client ${clientId} state:`, state);

          if (state === 'CONNECTED') {
            // Wait a bit more and check again
            setTimeout(async () => {
              if (client.info) {
                await this.handleManualReady(clientId, client);
              } else {
                this.logger.error(
                  `Client ${clientId} connected but still no info - restarting session`,
                );
                await this.restartSession(clientId);
              }
            }, 5000);
          } else {
            this.logger.error(
              `Client ${clientId} not ready after timeout, state: ${state}`,
            );
            await this.handleInitializationFailure(
              clientId,
              `Client not ready after timeout, state: ${state}`,
            );
          }
        } catch (stateError) {
          this.logger.error(`Failed to get state for ${clientId}:`, stateError);
          await this.handleInitializationFailure(
            clientId,
            'Failed to verify client state',
          );
        }
      }
    } catch (error) {
      this.logger.error(`Error handling ready timeout for ${clientId}:`, error);
      await this.handleInitializationFailure(
        clientId,
        'Ready timeout handling failed',
      );
    } finally {
      this.readyTimeouts.delete(clientId);
    }
  }

  // Manual ready handling for when the event doesn't fire
  private async handleManualReady(clientId: string, client: Client) {
    try {
      const phoneNumber = client.info?.wid?.user;
      this.logger.log(
        `Manually processing ready state for ${clientId} with phone: ${phoneNumber}`,
      );

      await this.updateSession(clientId, {
        status: 'connected',
        phoneNumber,
        lastActivity: new Date(),
        qrCode: undefined,
      });

      this.qrCodes.delete(clientId);
      this.logger.log(
        `Client ${clientId} (${phoneNumber}) manually set to ready!`,
      );

      // Send webhook
      await this.webhookService.sendWebhook(clientId, 'ready', {
        phoneNumber,
        clientId,
      });

      // Clear the timeout since we're done
      const readyTimeout = this.readyTimeouts.get(clientId);
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        this.readyTimeouts.delete(clientId);
      }
    } catch (error) {
      this.logger.error(
        `Error in manual ready handler for ${clientId}:`,
        error,
      );
    }
  }

  private async handleInitializationFailure(clientId: string, reason: string) {
    this.logger.error(`Initialization failed for ${clientId}: ${reason}`);

    // Clear any pending timeouts
    const readyTimeout = this.readyTimeouts.get(clientId);
    if (readyTimeout) {
      clearTimeout(readyTimeout);
      this.readyTimeouts.delete(clientId);
    }

    await this.updateSessionStatus(clientId, 'disconnected');
    await this.cleanupClient(clientId);
  }

  async handleIncomingMessage(clientId: string, message: WAMessage) {
    try {
      const messageDoc = await this.messageModel.create({
        clientId,
        messageId: message.id._serialized,
        from: message.from,
        to: message.to || clientId,
        body: message.body,
        type: message.type,
        direction: 'incoming',
        status: 'delivered',
      });

      await this.updateSession(clientId, {
        lastActivity: new Date(),
        messageCount: await this.messageModel.countDocuments({ clientId }),
      });

      await this.webhookService.sendWebhook(clientId, 'message', {
        id: message.id._serialized,
        from: message.from,
        to: message.to,
        body: message.body,
        type: message.type,
        timestamp: message.timestamp,
      });
    } catch (error) {
      this.logger.error(`Failed to handle incoming message:`, error);
    }
  }

  async sendMessage(
    clientId: string,
    to: string,
    message: string,
    type: string = 'text',
  ) {
    try {
      const client = this.clients.get(clientId);
      if (!client) {
        throw new Error('Client not found');
      }

      // Check if client is ready - improved check
      if (!client.info) {
        // Try to wait a bit and check again
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (!client.info) {
          throw new Error(
            'Client not ready. Please ensure WhatsApp is connected and try again.',
          );
        }
      }

      const chatId = to.includes('@') ? to : `${to}@c.us`;
      const sentMessage = await client.sendMessage(chatId, message);

      const messageDoc = await this.messageModel.create({
        clientId,
        messageId: sentMessage.id._serialized,
        from: client.info.wid._serialized,
        to: chatId,
        body: message,
        type,
        direction: 'outgoing',
        status: 'sent',
      });

      await this.updateSession(clientId, {
        lastActivity: new Date(),
        messageCount: await this.messageModel.countDocuments({ clientId }),
      });

      return {
        success: true,
        messageId: sentMessage.id._serialized,
        message: 'Message sent successfully',
      };
    } catch (error) {
      this.logger.error(`Failed to send message:`, error);
      throw new Error(`Failed to send message: ${error.message}`);
    }
  }

  async getSessionStatus(clientId: string) {
    const session = await this.sessionModel.findOne({ clientId });
    const client = this.clients.get(clientId);
    const qr = this.qrCodes.get(clientId);

    let clientState = 'unknown';
    if (client) {
      try {
        clientState = await client.getState();
      } catch (error) {
        this.logger.error(`Failed to get state for ${clientId}:`, error);
      }
    }

    return {
      clientId,
      status: session?.status || 'disconnected',
      phoneNumber: session?.phoneNumber,
      connected: !!(client && client.info),
      lastActivity: session?.lastActivity,
      messageCount: session?.messageCount || 0,
      qrCode: qr,
      isInitializing: this.initializingClients.has(clientId),
      clientState, // Add client state for debugging
      hasClientInfo: !!(client && client.info),
    };
  }

  async getAllSessions() {
    const sessions = await this.sessionModel.find().sort({ lastActivity: -1 });
    return sessions.map((session) => ({
      clientId: session.clientId,
      status: session.status,
      phoneNumber: session.phoneNumber,
      connected:
        this.clients.has(session.clientId) &&
        !!this.clients.get(session.clientId)?.info,
      lastActivity: session.lastActivity,
      messageCount: session.messageCount,
      isInitializing: this.initializingClients.has(session.clientId),
    }));
  }

  async deleteSession(clientId: string) {
    try {
      await this.cleanupClient(clientId);

      const sessionPath = path.resolve('./wa-sessions', `session-${clientId}`);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }

      this.qrCodes.delete(clientId);
      await this.sessionModel.deleteOne({ clientId });
      await this.messageModel.deleteMany({ clientId });

      return { success: true, message: 'Session deleted successfully' };
    } catch (error) {
      this.logger.error(`Failed to delete session ${clientId}:`, error);
      throw new Error(`Failed to delete session: ${error.message}`);
    }
  }

  async getMessages(clientId: string, limit: number = 50, offset: number = 0) {
    return await this.messageModel
      .find({ clientId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(offset)
      .exec();
  }

  async cleanupClient(clientId: string) {
    // Clear any pending timeouts
    const readyTimeout = this.readyTimeouts.get(clientId);
    if (readyTimeout) {
      clearTimeout(readyTimeout);
      this.readyTimeouts.delete(clientId);
    }

    const client = this.clients.get(clientId);
    if (client) {
      try {
        await client.destroy();
        this.logger.log(`Client ${clientId} destroyed successfully`);
      } catch (error) {
        this.logger.error(`Error cleaning up client ${clientId}:`, error);
      }
      this.clients.delete(clientId);
    }
    this.qrCodes.delete(clientId);
    this.initializingClients.delete(clientId);
  }

  async restartSession(clientId: string) {
    this.logger.log(`Restarting session ${clientId}`);
    await this.cleanupClient(clientId);
    await this.updateSessionStatus(clientId, 'disconnected');

    setTimeout(async () => {
      await this.initSession(clientId);
    }, 3000); // Increased delay

    return { success: true, message: 'Session restart initiated' };
  }

  // Add method to manually check and fix ready state
  async checkAndFixReadyState(clientId: string) {
    try {
      const client = this.clients.get(clientId);
      if (!client) {
        return { success: false, message: 'Client not found' };
      }

      const state = await client.getState();
      this.logger.log(
        `Manual check for ${clientId} - state: ${state}, has info: ${!!client.info}`,
      );

      if (
        (state === 'CONNECTED' || client.info) &&
        !this.readyTimeouts.has(clientId)
      ) {
        await this.handleManualReady(clientId, client);
        return { success: true, message: 'Ready state fixed manually' };
      }

      return {
        success: false,
        message: `Client state: ${state}, has info: ${!!client.info}`,
      };
    } catch (error) {
      this.logger.error(`Failed to check ready state for ${clientId}:`, error);
      return { success: false, message: error.message };
    }
  }

  private async updateSession(clientId: string, updates: Partial<Session>) {
    try {
      await this.sessionModel.updateOne(
        { clientId },
        { $set: updates },
        { upsert: true },
      );
    } catch (error) {
      this.logger.error(`Failed to update session ${clientId}:`, error);
    }
  }

  private async updateSessionStatus(
    clientId: string,
    status: Session['status'],
  ) {
    await this.updateSession(clientId, { status, lastActivity: new Date() });
  }
}
