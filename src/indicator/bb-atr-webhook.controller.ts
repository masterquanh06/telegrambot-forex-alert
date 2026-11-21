import { Controller, Post, Body, Logger } from '@nestjs/common';
import { BbAtrService } from './bb-atr.service';

@Controller('api/webhook')
export class BbAtrWebhookController {
  private readonly logger = new Logger(BbAtrWebhookController.name);

  constructor(private readonly bbAtrService: BbAtrService) {}

  @Post('bbatr')
  async handleMt5Alert(@Body() body: any) {
    this.logger.log(`📥 [MT5 Webhook Alert] Nhận tín hiệu từ MT5: ${JSON.stringify(body)}`);
    return this.bbAtrService.handleMt5WebhookAlert(body);
  }
}
