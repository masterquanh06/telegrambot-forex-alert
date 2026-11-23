import { Module, forwardRef } from '@nestjs/common';
import { BbAtrService } from './bb-atr.service';
import { BbAtrWebhookController } from './bb-atr-webhook.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramModule } from '../telegram/telegram.module';
import { LiquiditySweepModule } from '../services/liquiditySweep.module';
import { SuperTierModule } from '../common/super-tier.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => TelegramModule),
    LiquiditySweepModule,
    SuperTierModule,
  ],
  controllers: [BbAtrWebhookController],
  providers: [BbAtrService],
  exports: [BbAtrService],
})
export class IndicatorModule {}
