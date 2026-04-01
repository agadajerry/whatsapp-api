import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { Client, RemoteAuth } from 'whatsapp-web.js';
import { MongoStore } from 'wwebjs-mongo';
import * as puppeteer from 'puppeteer';
import { HttpService } from '@nestjs/axios';

import { Session, SessionDocument } from 'src/schema/session.schema';
import { Message, MessageDocument } from 'src/schema/message.schema';
import { Webhook, WebhookDocument } from 'src/schema/webhook.schema';
import { SessionGateway } from 'src/ws/session-gateway';
import { signPayload } from 'src/utils/webhook-signature.util';

@Injectable()
export class SessionService implements OnModuleInit {
  private readonly logger = new Logger(SessionService.name);

  private readonly runtimeClients = new Map<string, Client>();
  private readonly initializing = new Set<string>();
  private readonly processedMessages = new Set<string>();
  private readonly healthIntervals = new Map<string, NodeJS.Timeout>();

  private store: InstanceType<typeof MongoStore>;

  private messageQueue: any[] = [];
  private processingQueue = false;

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
  ) {}

  async onModuleInit() {
    // 🔥 WAIT for connection to be ready
    if (this.mongooseConnection.readyState !== 1) {
      this.logger.log('⏳ Waiting for Mongo connection...');
      await new Promise<void>((resolve) => {
        this.mongooseConnection.once('connected', () => resolve());
      });
    }

this.store = new MongoStore({
  mongoose: { connection: this.mongooseConnection } as any,
});

    this.startQueueProcessor();

    const sessions = await this.sessionModel.find({ isAuthenticated: true });

    for (const s of sessions) {
      this.initializeClient(s.sessionId, s.userId);
    }
  }

  /* =========================================================
     CLIENT INITIALIZATION
  ========================================================= */

  async initializeClient(sessionId: string, userId: Types.ObjectId) {
    if (this.initializing.has(sessionId)) return;

    this.initializing.add(sessionId);

    try {
      const client = new Client({
        authStrategy: new RemoteAuth({
          clientId: sessionId,
          store: this.store,
          backupSyncIntervalMs: 300000,
        }),

        puppeteer: {
          headless: true,
          executablePath: puppeteer.executablePath(),
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
          ],
        },
      });

      this.bindEvents(client, sessionId, userId.toString());
      this.runtimeClients.set(sessionId, client);

      await this.updateSession(sessionId, { status: 'INITIALIZING' });

      // ✅ Prevent hanging init
      await Promise.race([
        client.initialize(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Init timeout')), 60000),
        ),
      ]);

      this.logger.log(`✓ Initialized ${sessionId}`);
    } catch (err) {
      this.logger.error(`Init failed ${sessionId}`, err);

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

    client.on('qr', async (qr) => {
      await this.updateSession(sessionId, { status: 'QR', qrCode: qr });
      this.gateway.emitSessionQr(userId, sessionId, qr);
    });

    client.on('authenticated', async () => {
      await this.updateSession(sessionId, { status: 'AUTHENTICATED' });
    });

    client.on('remote_session_saved', () => {
      this.logger.log(`☁️ Session persisted: ${sessionId}`);
    });

    client.on('ready', async () => {
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

    client.on('disconnected', () => this.handleDisconnect(sessionId, userId));

    client.on('auth_failure', () => this.handleAuthFailure(sessionId, userId));

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

    await this.updateSession(sessionId, {
      status: 'DISCONNECTED',
      isAuthenticated: false,
    });

    this.gateway.emitSessionDisconnected(userId, sessionId);
    this.runtimeClients.delete(sessionId);
  }

  private async handleAuthFailure(sessionId: string, userId: string) {
    this.clearHealth(sessionId);

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

    // 2. Explicitly delete from Mongo store (IMPORTANT)
    try {
      await this.store.delete({ session: sessionId });
      this.logger.log(`🗑️ RemoteAuth session deleted from Mongo: ${sessionId}`);
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
