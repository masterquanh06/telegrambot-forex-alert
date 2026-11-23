import { Module, forwardRef } from '@nestjs/common';
import { SuperTierService } from './super-tier.service';
import { CallMeBotService } from './callmebot.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [PrismaModule, forwardRef(() => TelegramModule)],
  providers: [SuperTierService, CallMeBotService],
  exports: [SuperTierService, CallMeBotService],
})
export class SuperTierModule {}
