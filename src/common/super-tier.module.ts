import { Module, forwardRef } from '@nestjs/common';
import { SuperTierService } from './super-tier.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [PrismaModule, forwardRef(() => TelegramModule)],
  providers: [SuperTierService],
  exports: [SuperTierService],
})
export class SuperTierModule {}
