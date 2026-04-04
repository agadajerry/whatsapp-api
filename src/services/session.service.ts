import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { Client, LocalAuth } from 'whatsapp-web.js';
import { HttpService } from '@nestjs/axios';

import { Session, SessionDocument } from 'src/schema/session.schema';
import { Message, MessageDocument } from 'src/schema/message.schema';
import { Webhook, WebhookDocument } from 'src/schema/webhook.schema';
import { SessionGateway } from 'src/ws/session-gateway';
import { signPayload } from 'src/utils/webhook-signature.util';
import * as path from 'path';
import * as fs from 'fs';
import { createPuppeteerConfig } from './puppeteer.factory';
@Injectable()
export class SessionService implements OnModuleInit {
  private readonly logger = new Logger(SessionService.name);

  private readonly runtimeClients = new Map<string, Client>();
  private readonly initializing = new Set<string>();
  private readonly processedMessages = new Set<string>();
  private readonly healthIntervals = new Map<string, NodeJS.Timeout>();

  private messageQueue: any[] = [];
  private processingQueue = false;
  private readonly SESSIONS_DIR = './sessions';

  constructor(
    @InjectConnection()
    private readonly mongooseConnection: Connection,

    @InjectModel(Session.name)
    private readonly sessionModel: Model<SessionDocument>,

    @InjectModel(Message.name)
    private readonly messageModel: Model<MessageDocument>,

    @InjectModel(Webhook.name)
    private readonly webhookModel: Model<WebhookDocument>,

    private readonly httpService: HttpService,
    private readonly gateway: SessionGateway,
  ) {
    this.ensureSessionsDirectory();
  }

  private ensureSessionsDirectory() {
    if (!fs.existsSync(this.SESSIONS_DIR)) {
      fs.mkdirSync(this.SESSIONS_DIR, { recursive: true });
    }
  }
  async onModuleInit() {
    // ✅ Removed: MongoStore initialization — not needed for LocalAuth

    this.startQueueProcessor();

    const sessions = await this.sessionModel.find({ isAuthenticated: true });

    for (const s of sessions) {
      try {
        await this.initializeClient(s.sessionId, s.userId);
      } catch (error) {
        this.logger.error(
          `Failed to restore session ${sessions}: ${error.message}`,
        );

        // Mark session as disconnected if restoration fails
        await this.sessionModel.updateOne(
          { sessionId: sessions },
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

  /* =========================================================
     CLIENT INITIALIZATION
  ========================================================= */

  async initializeClient(sessionId: string, userId: Types.ObjectId) {
    if (this.initializing.has(sessionId)) return;

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

    this.initializing.add(sessionId);

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

    try {
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

      this.bindEvents(client, sessionId, userId.toString());
      this.runtimeClients.set(sessionId, client);

      await this.updateSession(sessionId, { status: 'INITIALIZING' });

      // ✅ Add this block here
      const page = (client as any).pupPage;
      if (page) {
        page.on('pageerror', (err: Error) => {
          this.logger.error(`[${sessionId}] Page error: ${err.message}`);
        });
        page.on('console', (msg: any) => {
          if (msg.type() === 'error') {
            this.logger.error(`[${sessionId}] Console error: ${msg.text()}`);
          }
        });
      }

      await Promise.race([
        client.initialize(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Init timeout')), 300000),
        ),
      ]);
    } catch (err) {
      this.logger.error(`Init failed ${sessionId}`, err);

      const orphanedClient = this.runtimeClients.get(sessionId);
      if (orphanedClient) {
        try {
          await orphanedClient.destroy();
        } catch (destroyErr) {
          this.logger.warn(
            `Failed to destroy orphaned client: ${destroyErr.message}`,
          );
        }
      }

      await this.updateSession(sessionId, {
        status: 'FAILED',
        isAuthenticated: false,
      });

      this.runtimeClients.delete(sessionId);
    } finally {
      this.initializing.delete(sessionId);
    }
  }

  /* =========================================================
     EVENTS
  ========================================================= */

  private bindEvents(client: Client, sessionId: string, userId: string) {
    client.removeAllListeners();

    // ✅ Catch any puppeteer page errors
    client.on('loading_screen', (percent, message) => {
      this.logger.log(`[${sessionId}] Loading ${percent}% — ${message}`);
    });

    client.on('qr', async (qr) => {
      this.logger.log(`[${sessionId}] QR received`);
      await this.updateSession(sessionId, { status: 'QR', qrCode: qr });
      this.gateway.emitSessionQr(userId, sessionId, qr);
    });

    client.on('authenticated', async () => {
      this.logger.log(`[${sessionId}] ✅ Authenticated`);
        this.gateway.emitSessionAuthenticated(userId, sessionId);
      await this.updateSession(sessionId, { status: 'AUTHENTICATED' });
    });

    client.on('auth_failure', (msg) => {
      this.gateway.emitAuthFailure(userId, sessionId);
      this.logger.error(`[${sessionId}] ❌ Auth failure: ${msg}`);
      this.handleAuthFailure(sessionId, userId);
    });

    client.on('change_state', (state) => {
      // ✅ This fires on every internal WA state transition — key for debugging
      this.logger.log(`[${sessionId}] State → ${state}`);
    });

    client.on('ready', async () => {
      this.logger.log(`[${sessionId}] 🟢 Ready`);
      const phone = client.info?.wid?.user;
      await this.updateSession(sessionId, {
        status: 'READY',
        phoneNumber: phone,
        isAuthenticated: true,
        qrCode: null,
      });
      this.gateway.emitSessionReady(userId, sessionId, phone);
      this.startHealthMonitor(client, sessionId, userId);
    });

    client.on('disconnected', (reason) => {
      // ✅ reason tells you WHY it dropped
      this.logger.warn(`[${sessionId}] Disconnected: ${reason}`);
      this.handleDisconnect(sessionId, userId);
    });

    client.on('message', (msg) => this.enqueueMessage(sessionId, userId, msg));
  }

  /* =========================================================
     QUEUE (SAFE DRAIN)
  ========================================================= */

  private enqueueMessage(sessionId: string, userId: string, msg: any) {
    if (msg.fromMe) return;
    this.messageQueue.push({ sessionId, userId, msg });
  }

  private startQueueProcessor() {
    setInterval(async () => {
      if (this.processingQueue) return;

      this.processingQueue = true;

      while (this.messageQueue.length) {
        const job = this.messageQueue.shift();
        try {
          await this.processMessage(job);
        } catch (err) {
          this.logger.error('Queue error', err);
        }
      }

      this.processingQueue = false;
    }, 500);
  }

  private async processMessage(job: any) {
    const { sessionId, userId, msg } = job;

    const id = msg.id?._serialized;
    if (!id || this.processedMessages.has(id)) return;

    this.processedMessages.add(id);

    const saved = await this.messageModel.create({
      clientId: sessionId,
      from: msg.from,
      to: msg.to,
      body: msg.body,
      messageId: id,
      timestamp: new Date(msg.timestamp * 1000),
    });

    this.gateway.emitIncomingMessage(userId, sessionId, saved);
    await this.dispatchWebhook(sessionId, saved);
  }

  /* =========================================================
     WEBHOOK
  ========================================================= */

  private async dispatchWebhook(sessionId: string, message: any) {
    const webhook: any = await this.webhookModel.findOne({
      clientId: sessionId,
      enabled: true,
    });

    if (!webhook) return;

    const payload = { event: 'message.received', data: message };
    const signature = signPayload(payload, webhook.secret);

    for (let i = 0; i < 5; i++) {
      try {
        await this.httpService.axiosRef.post(webhook.url, payload, {
          headers: { 'X-Webhook-Signature': signature },
          timeout: 5000,
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
  }

  /* =========================================================
     HEALTH
  ========================================================= */

  private startHealthMonitor(
    client: Client,
    sessionId: string,
    userId: string,
  ) {
    const existing = this.healthIntervals.get(sessionId);
    if (existing) clearInterval(existing);

    const interval = setInterval(async () => {
      try {
        const state = await client.getState();
        if (state !== 'CONNECTED') {
          this.logger.warn(`⚠️ ${sessionId} unstable: ${state}`);
        }
      } catch {
        this.logger.error(`💥 Crash: ${sessionId}`);
        clearInterval(interval);
        this.healthIntervals.delete(sessionId);
        await this.recover(sessionId, userId);
      }
    }, 20000);

    this.healthIntervals.set(sessionId, interval);
  }

  private async recover(sessionId: string, userId: string) {
    this.runtimeClients.delete(sessionId);

    await this.updateSession(sessionId, { status: 'DISCONNECTED' });

    setTimeout(() => {
      this.initializeClient(sessionId, new Types.ObjectId(userId));
    }, 10000);
  }

  private async handleDisconnect(sessionId: string, userId: string) {
    this.clearHealth(sessionId);
    const client = this.runtimeClients.get(sessionId);
    if (client) {
      await client.destroy();
    }

    await this.updateSession(sessionId, {
      status: 'DISCONNECTED',
      isAuthenticated: false,
    });

    this.gateway.emitSessionDisconnected(userId, sessionId);
    this.runtimeClients.delete(sessionId);
  }

  private async handleAuthFailure(sessionId: string, userId: string) {
    this.clearHealth(sessionId);
    const client = this.runtimeClients.get(sessionId);
    if (client) {
      await client.destroy();
    }

    await this.updateSession(sessionId, {
      status: 'FAILED',
      isAuthenticated: false,
    });

    this.runtimeClients.delete(sessionId);
  }

  private clearHealth(sessionId: string) {
    const interval = this.healthIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.healthIntervals.delete(sessionId);
    }
  }

  /* =========================================================
     SEND
  ========================================================= */

  async sendMessage(sessionId: string, to: string, text: string) {
    const client = this.runtimeClients.get(sessionId);
    if (!client) throw new Error('Client not found');

    return client.sendMessage(`${to}@c.us`, text);
  }

  /* =========================================================
     DISCONNECT
  ========================================================= */

  async disconnectClient(sessionId: string) {
    const client = this.runtimeClients.get(sessionId);

    if (client) {
      await client.logout();
      await client.destroy();
      this.runtimeClients.delete(sessionId);
    }

    await this.updateSession(sessionId, {
      status: 'DISCONNECTED',
      isAuthenticated: false,
    });
  }

  /* =========================================================
     UTIL
  ========================================================= */

  private async updateSession(sessionId: string, patch: any) {
    await this.sessionModel.updateOne({ sessionId }, patch);
  }

  async getAllSessions(userId: Types.ObjectId): Promise<Session[]> {
    return this.sessionModel
      .find({ userId, status: { $ne: 'DELETED' } })
      .exec();
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.sessionModel.findOne({ sessionId });
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const client = this.runtimeClients.get(sessionId);

    // 1. Stop client safely
    if (client) {
      try {
        await client.logout(); // removes remote auth session internally
        await client.destroy();
        this.logger.log(`✓ Client ${sessionId} destroyed`);
      } catch (err) {
        this.logger.warn(`Destroy error ${sessionId}: ${err.message}`);
      }

      this.runtimeClients.delete(sessionId);
    }

    try {
      // await this.store.delete({ session: sessionId });
    } catch (err) {
      this.logger.warn(`Store delete failed ${sessionId}: ${err.message}`);
    }

    // 3. Release distributed lock (if using it)
    await this.sessionModel.updateOne(
      { sessionId },
      {
        ownerId: null,
        lockUntil: null,
        status: 'DELETED',
        isAuthenticated: false,
        qrCode: null,
        phoneNumber: null,
      },
    );

    this.gateway.emitSessionDisconnected(session.userId.toString(), sessionId);

    this.logger.log(`✅ Session ${sessionId} fully deleted`);
  }
}
