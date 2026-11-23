import { Module, forwardRef } from '@nestjs/common';
import { SmcService } from './smc.service';
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
  providers: [SmcService],
  exports: [SmcService],
})
export class SmcModule {}
