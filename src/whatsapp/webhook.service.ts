import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios from 'axios';
import * as crypto from 'crypto';
import { Webhook, WebhookDocument } from 'src/schema/webhook.schema';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @InjectModel(Webhook.name) private webhookModel: Model<WebhookDocument>,
  ) {}

  async createWebhook(clientId: string, webhookData: Partial<Webhook>) {
    return await this.webhookModel.findOneAndUpdate(
      { clientId },
      { ...webhookData, clientId },
      { upsert: true, new: true }
    );
  }

  async sendWebhook(clientId: string, event: string, data: any) {
    try {
      const webhook = await this.webhookModel.findOne({
        clientId,
        enabled: true,
        $or: [
          { events: { $in: [event] } },
          { events: { $size: 0 } }
        ]
      });

      if (!webhook) return;

      const payload = {
        event,
        clientId,
        timestamp: new Date().toISOString(),
        data
      };

      const headers: any = {
        'Content-Type': 'application/json',
        'User-Agent': 'WhatsApp-API-Webhook/1.0'
      };

      if (webhook.secret) {
        const signature = crypto
          .createHmac('sha256', webhook.secret)
          .update(JSON.stringify(payload))
          .digest('hex');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
      }

      await axios.post(webhook.url, payload, {
        headers,
        timeout: 10000
      });

      this.logger.log(`Webhook sent successfully for ${clientId}: ${event}`);
    } catch (error) {
      this.logger.error(`Failed to send webhook for ${clientId}:`, error.message);
    }
  }

  async getWebhook(clientId: string) {
    return await this.webhookModel.findOne({ clientId });
  }

  async deleteWebhook(clientId: string) {
    return await this.webhookModel.deleteOne({ clientId });
  }
}