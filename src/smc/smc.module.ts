import { Module, forwardRef } from '@nestjs/common';
import { SmcService } from './smc.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramModule } from '../telegram/telegram.module';
import { LiquiditySweepModule } from '../services/liquiditySweep.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => TelegramModule),
    LiquiditySweepModule,
  ],
  providers: [SmcService],
  exports: [SmcService],
})
export class SmcModule {}
