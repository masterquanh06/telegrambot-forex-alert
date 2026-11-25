import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { WatchlistModule } from './watchlist/watchlist.module';
import { TelegramModule } from './telegram/telegram.module';
import { CronModule } from './cron/cron.module';
import { MacroModule } from './macro/macro.module';
import { GoldModule } from './gold/gold.module';
import { AlertModule } from './alert/alert.module';
import { IndicatorModule } from './indicator/indicator.module';
import { SmcModule } from './smc/smc.module';
import { LiquiditySweepModule } from './services/liquiditySweep.module';
import { SuperTierModule } from './common/super-tier.module';
import { SubscriberCacheModule } from './common/subscriber-cache.module';

@Controller()
class HelloController {
  @Get()
  hello() {
    return {
      message: 'Hello World',
    };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    SubscriberCacheModule,
    WatchlistModule,
    TelegramModule,
    CronModule,
    MacroModule,
    GoldModule,
    AlertModule,
    IndicatorModule,
    SmcModule,
    LiquiditySweepModule,
    SuperTierModule,
  ],
  controllers: [HelloController],
})
export class AppModule {}
