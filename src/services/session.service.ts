import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { HttpService } from '@nestjs/axios';

import { Session, SessionDocument } from 'src/schema/session.schema';
import { Message, MessageDocument } from 'src/schema/message.schema';
import { Webhook, WebhookDocument } from 'src/schema/webhook.schema';
import { WebhookService } from './webhook.service';
import { signPayload } from 'src/utils/webhook-signature.util';
import { SessionGateway } from 'src/ws/session-gateway';
import { createPuppeteerConfig } from './puppeteer.factory';

@Injectable()
export class SessionService implements OnModuleInit {
  private readonly logger = new Logger(SessionService.name);
  private readonly runtimeClients = new Map<string, Client>();
  private readonly SESSIONS_DIR = './sessions';
  private readonly initializingClients = new Set<string>(); // Prevent duplicate initialization

  constructor(
    @InjectModel(Session.name)
    private readonly sessionModel: Model<SessionDocument>,

    @InjectModel(Message.name)
    private readonly messageModel: Model<MessageDocument>,

    @InjectModel(Webhook.name)
    private readonly webhookModel: Model<WebhookDocument>,

    private readonly webhookService: WebhookService,
    private readonly httpService: HttpService,
    private readonly gateway: SessionGateway,
  ) {
    this.ensureSessionsDirectory();
  }

  /* --------------------------------------------------------
     APP BOOTSTRAP
  ---------------------------------------------------------*/

  async onModuleInit() {
    this.logger.log('Restoring authenticated sessions...');

    const sessions = await this.sessionModel.find({
      isAuthenticated: true,
    });

    for (const session of sessions) {
      try {
        this.logger.log(`Restoring session ${session.sessionId}`);
        await this.initializeClient(session.sessionId, session.userId);
      } catch (error) {
        this.logger.error(
          `Failed to restore session ${session.sessionId}: ${error.message}`,
        );

        // Mark session as disconnected if restoration fails
        await this.sessionModel.updateOne(
          { sessionId: session.sessionId },
          {
            status: 'Disconnected',
            isAuthenticated: false,
            qrCode: null,
          },
        );
      }
    }

    this.logger.log(
      `Session restoration complete. Active: ${this.runtimeClients.size}`,
    );
  }

  private ensureSessionsDirectory() {
    if (!fs.existsSync(this.SESSIONS_DIR)) {
      fs.mkdirSync(this.SESSIONS_DIR, { recursive: true });
    }
  }

  /* --------------------------------------------------------
     CLIENT INITIALIZATION
  ---------------------------------------------------------*/

  async initializeClient(
    sessionId: string,
    userId: Types.ObjectId,
  ): Promise<void> {
    // Prevent duplicate initialization
    if (this.initializingClients.has(sessionId)) {
      this.logger.warn(`Session ${sessionId} is already initializing`);
      return;
    }

    // Check if client already exists and is connected
    if (this.runtimeClients.has(sessionId)) {
      const existingClient: any = this.runtimeClients.get(sessionId);
      const state = await existingClient.getState();

      if (state === 'CONNECTED') {
        this.logger.warn(`Session ${sessionId} is already connected`);
        return;
      } else {
        // Client exists but not connected, clean it up
        this.logger.warn(`Cleaning up stale client for ${sessionId}`);
        try {
          await existingClient.destroy();
        } catch (err) {
          this.logger.warn(`Error destroying stale client: ${err.message}`);
        }
        this.runtimeClients.delete(sessionId);
      }
    }

    this.initializingClients.add(sessionId);

    try {
      let session = await this.sessionModel.findOne({ sessionId });

      if (!session) {
        session = await this.sessionModel.create({
          sessionId,
          userId,
          status: 'Initializing',
          isAuthenticated: false,
        });
      } else {
        await this.sessionModel.updateOne(
          { sessionId },
          { status: 'Initializing', qrCode: null },
        );
      }

      const sessionDataPath = path.join(
        this.SESSIONS_DIR,
        `session-${sessionId}`,
      );

      const puppeteerConfig = createPuppeteerConfig(sessionDataPath);

      const client = new Client({
        authStrategy: new LocalAuth({
          dataPath: sessionDataPath,
          clientId: sessionId,
        }),

        puppeteer: puppeteerConfig,

        webVersionCache: {
          type: 'none',
        },
      });
      
      this.monitorClientHealth(client, sessionId);

      this.runtimeClients.set(sessionId, client);
      this.setupClientEvents(client, sessionId, userId, sessionDataPath);

      await client.initialize();

      client.on('ready', async () => {
        this.logger.log(`✓ Session ${sessionId} is ready`);

        // 🔥 Access Puppeteer Page
        const browser = await (client as any).pupBrowser;
        const pages = await browser.pages();
        const page = pages[0];

        // Apply optimizations
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        );

        // Optional: block heavy resources
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
            req.abort();
          } else {
            req.continue();
          }
        });

        const phoneNumber = client.info?.wid?.user ?? '';

        await this.sessionModel.updateOne(
          { sessionId },
          {
            status: 'Connected',
            phoneNumber,
            qrCode: null,
            isAuthenticated: true,
          },
        );

        this.gateway.emitSessionReady(
          userId.toString(),
          sessionId,
          phoneNumber,
        );
      });

      this.logger.log(`✓ Client initialized for session ${sessionId}`);
    } catch (error) {
      this.logger.error(
        `Failed to initialize client for ${sessionId}: ${error.message}`,
        error.stack,
      );

      // Clean up on failure
      this.runtimeClients.delete(sessionId);

      await this.sessionModel.updateOne(
        { sessionId },
        {
          status: 'Initialization Failed',
          isAuthenticated: false,
          qrCode: null,
        },
      );

      throw error;
    } finally {
      this.initializingClients.delete(sessionId);
    }
  }

  private setupClientEvents(
    client: Client,
    sessionId: string,
    userId: Types.ObjectId,
    sessionDataPath: string,
  ) {
    /* ---------------- QR CODE EVENT ---------------- */

    client.on('qr', async (qr) => {
      this.logger.log(`QR code generated for ${sessionId}`);

      await this.sessionModel.updateOne(
        { sessionId },
        { status: 'QR Code Generated', qrCode: qr },
      );

      this.gateway.emitSessionQr(userId.toString(), sessionId, qr);
    });

    /* ---------------- READY EVENT ---------------- */

    client.on('ready', async () => {
      this.logger.log(`✓ Session ${sessionId} is ready`);

      const phoneNumber = client.info?.wid?.user ?? '';

      await this.sessionModel.updateOne(
        { sessionId },
        {
          status: 'Connected',
          phoneNumber,
          qrCode: null,
          isAuthenticated: true,
        },
      );

      this.gateway.emitSessionReady(userId.toString(), sessionId, phoneNumber);
    });

    /* ---------------- AUTHENTICATED EVENT ---------------- */

    client.on('authenticated', async () => {
      this.logger.log(`✓ Session ${sessionId} authenticated`);

      await this.sessionModel.updateOne(
        { sessionId },
        { isAuthenticated: true },
      );
    });

    /* ---------------- AUTH FAILURE EVENT ---------------- */

    client.on('auth_failure', async (msg) => {
      this.logger.error(`✗ Auth failure for ${sessionId}: ${msg}`);

      await this.sessionModel.updateOne(
        { sessionId },
        {
          status: 'Authentication Failure',
          isAuthenticated: false,
          qrCode: null,
        },
      );

      this.gateway.emitAuthFailure(userId.toString(), sessionId);

      // Clean up session data
      if (fs.existsSync(sessionDataPath)) {
        fs.rmSync(sessionDataPath, { recursive: true, force: true });
      }

      this.runtimeClients.delete(sessionId);

      // Attempt to destroy client
      try {
        await client.destroy();
      } catch (err) {
        this.logger.warn(
          `Error destroying client after auth failure: ${err.message}`,
        );
      }
    });

    /* ---------------- DISCONNECTED EVENT ---------------- */

    client.on('disconnected', async (reason) => {
      this.logger.warn(`✗ Session ${sessionId} disconnected: ${reason}`);

      await this.sessionModel.updateOne(
        { sessionId },
        {
          status: 'Disconnected',
          isAuthenticated: false,
          qrCode: null,
          phoneNumber: null,
        },
      );

      this.gateway.emitSessionDisconnected(userId.toString(), sessionId);

      this.runtimeClients.delete(sessionId);

      try {
        await client.destroy();
      } catch (err) {
        this.logger.warn(
          `Error destroying disconnected client: ${err.message}`,
        );
      }
    });

    /* ---------------- MESSAGE EVENT ---------------- */

    client.on('message', (msg) =>
      this.handleIncomingMessage(sessionId, userId, msg),
    );

    /* ---------------- LOADING SCREEN EVENT (optional) ---------------- */

    client.on('loading_screen', (percent, message) => {
      this.logger.debug(`Loading ${sessionId}: ${percent}% - ${message}`);
    });
  }

  async disconnectClient(sessionId: string): Promise<void> {
    const session = await this.sessionModel.findOne({ sessionId });

    console.log(sessionId);

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const client = this.runtimeClients.get(sessionId);
    console.log(client, 'client');

    if (client) {
      try {
        await client.logout();
        await client.destroy();
        this.logger.log(`✓ Client ${sessionId} logged out and destroyed`);
      } catch (err) {
        this.logger.warn(
          `Error while destroying client ${sessionId}: ${err.message}`,
        );
      }
      this.runtimeClients.delete(sessionId);
    }

    // Remove local auth data
    const sessionDataPath = path.join(
      this.SESSIONS_DIR,
      `session-${sessionId}`,
    );

    if (fs.existsSync(sessionDataPath)) {
      fs.rmSync(sessionDataPath, { recursive: true, force: true });
      this.logger.log(`✓ Removed session data for ${sessionId}`);
    }

    await this.sessionModel.updateOne(
      { sessionId },
      {
        status: 'Disconnected',
        isAuthenticated: false,
        qrCode: null,
        phoneNumber: null,
      },
    );

    this.gateway.emitSessionDisconnected(session.userId.toString(), sessionId);
    this.logger.log(`✓ Session ${sessionId} disconnected manually`);
  }

  async deleteClient(sessionId: string): Promise<void> {
    const session = await this.sessionModel.findOne({ sessionId });

    console.log(session);

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const client = this.runtimeClients.get(sessionId);

    if (client) {
      try {
        await client.logout();
        await client.destroy();
        this.logger.log(`✓ Client ${sessionId} logged out and destroyed`);
      } catch (err) {
        this.logger.warn(
          `Error while destroying client ${sessionId}: ${err.message}`,
        );
      }
      this.runtimeClients.delete(sessionId);
    }

    // Remove local auth data
    const sessionDataPath = path.join(
      this.SESSIONS_DIR,
      `session-${sessionId}`,
    );

    if (fs.existsSync(sessionDataPath)) {
      fs.rmSync(sessionDataPath, { recursive: true, force: true });
      this.logger.log(`✓ Removed session data for ${sessionId}`);
    }

    await this.sessionModel.updateOne(
      { sessionId },
      {
        status: 'DELETED',
        isAuthenticated: false,
        qrCode: null,
        phoneNumber: null,
      },
    );

    this.gateway.emitSessionDisconnected(session.userId.toString(), sessionId);
    this.logger.log(`✓ Session ${sessionId} disconnected manually`);
  }
  /* --------------------------------------------------------
     RECEIVE MESSAGE
  ---------------------------------------------------------*/

  private async handleIncomingMessage(
    sessionId: string,
    userId: Types.ObjectId,
    msg: any,
  ) {
    try {
      if (msg.fromMe) return;

      console.log(msg);

      const savedMessage = await this.messageModel.create({
        clientId: sessionId,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        messageId: msg.id?._serialized,
        timestamp: new Date(msg.timestamp * 1000),
        type: msg.type,
      });

      this.gateway.emitIncomingMessage(userId.toString(), sessionId, {
        id: savedMessage.id,
        from: savedMessage.from,
        to: savedMessage.to,
        body: savedMessage.body,
        type: savedMessage.type,
        timestamp: savedMessage.createdAt,
      });

      const webhook = await this.webhookModel.findOne({
        clientId: sessionId,
        enabled: true,
        events: 'message.received',
      });

      // console.log(webhook);

      if (webhook) {
        const payload = {
          event: 'message.received',
          sessionId,
          data: {
            id: savedMessage.id,
            from: savedMessage.from,
            to: savedMessage.to,
            body: savedMessage.body,
            type: savedMessage.type,
            timestamp: savedMessage.createdAt,
          },
        };

        this.deliverWebhook(webhook, payload);
      }
    } catch (error) {
      this.logger.error(
        `Failed to process incoming message for ${sessionId}: ${error.message}`,
        error.stack,
      );
    }
  }

  private async deliverWebhook(webhook: any, payload: any) {
    const signature = signPayload(payload, webhook.secret + 'nkkn');

    try {
      await this.httpService.axiosRef.post(
        'http://localhost:3001/api/test/webhook',
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': `sha256=${signature}`,
          },
          timeout: 5000,
        },
      );

      this.logger.log(`✓ Webhook delivered to ${webhook.url}`);
    } catch (err) {
      this.logger.warn(`✗ Webhook delivery failed: ${err.message}`);
    }
  }

  /* --------------------------------------------------------
     SEND MESSAGE
  ---------------------------------------------------------*/

  async sendMessage(sessionId: string, to: string, message: string) {
    const session = await this.sessionModel.findOne({ sessionId });

    if (!session || session.status !== 'Connected') {
      throw new Error(`Session ${sessionId} is not connected`);
    }

    const client = this.runtimeClients.get(sessionId);

    if (!client) {
      throw new Error(`Client not loaded in memory for ${sessionId}`);
    }

    const chatId = `${to.replace('+', '')}@c.us`;
    const msg = await client.sendMessage(chatId, message);

    this.gateway.emitMessageSent(
      session.userId.toString(),
      sessionId,
      msg.id._serialized,
    );

    return msg;
  }

  /* --------------------------------------------------------
     SEND ATTACHMENT
  ---------------------------------------------------------*/

  async sendAttachment(
    sessionId: string,
    to: string,
    file: string,
    caption?: string,
    type?: string,
  ) {
    const session = await this.sessionModel.findOne({ sessionId });

    if (!session || session.status !== 'Connected') {
      throw new Error(`Session ${sessionId} is not connected`);
    }

    const client = this.runtimeClients.get(sessionId);

    if (!client) {
      throw new Error(`Client not loaded in memory for ${sessionId}`);
    }

    let media: MessageMedia;

    if (fs.existsSync(file)) {
      media = MessageMedia.fromFilePath(file);
    } else if (file.startsWith('http')) {
      media = await MessageMedia.fromUrl(file, { unsafeMime: true });
    } else {
      if (!type) {
        throw new Error('Attachment type is required for base64 files');
      }
      const base64 = file.includes(',') ? file.split(',')[1] : file;
      media = new MessageMedia(type, base64);
    }

    const chatId = `${to.replace('+', '')}@c.us`;
    const msg = await client.sendMessage(chatId, media, { caption });

    this.gateway.emitMessageSent(
      session.userId.toString(),
      sessionId,
      msg.id._serialized,
    );

    return msg;
  }

  /* --------------------------------------------------------
     UTILITY METHODS
  ---------------------------------------------------------*/

  async getSessionStatus(sessionId: string) {
    const session = await this.sessionModel.findOne({ sessionId });
    const client = this.runtimeClients.get(sessionId);

    let clientState = 'NOT_LOADED';

    if (client) {
      try {
        clientState = await client.getState();
      } catch (err) {
        clientState = 'ERROR';
      }
    }

    return {
      session: session?.toObject(),
      clientState,
      isInMemory: this.runtimeClients.has(sessionId),
    };
  }

  async getAllSessions(userId: Types.ObjectId) {
    return this.sessionModel.find({ userId }).exec();
  }

  private monitorClientHealth(client: Client, sessionId: string) {
    setInterval(async () => {
      try {
        const state = await client.getState();

        if (state !== 'CONNECTED') {
          this.logger.warn(`⚠️ Session ${sessionId} unstable: ${state}`);
        }
      } catch (err) {
        this.logger.error(`💥 Client crash detected: ${sessionId}`);

        this.runtimeClients.delete(sessionId);

        this.sessionModel.updateOne(
          { sessionId },
          { status: 'Crashed', isAuthenticated: false },
        );
      }
    }, 15000);
  }
}
