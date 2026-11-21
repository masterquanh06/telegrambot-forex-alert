import { Module, forwardRef } from '@nestjs/common';
import { SmcService } from './smc.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => TelegramModule),
  ],
  providers: [SmcService],
  exports: [SmcService],
})
export class SmcModule {}
