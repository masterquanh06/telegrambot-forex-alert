import { Module, forwardRef } from '@nestjs/common';
import { BbAtrService } from './bb-atr.service';
import { BbAtrWebhookController } from './bb-atr-webhook.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => TelegramModule),
  ],
  controllers: [BbAtrWebhookController],
  providers: [BbAtrService],
  exports: [BbAtrService],
})
export class IndicatorModule {}
