import { Module, forwardRef } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { WatchlistModule } from '../watchlist/watchlist.module';
import { MacroModule } from '../macro/macro.module';
import { GoldModule } from '../gold/gold.module';
import { AlertModule } from '../alert/alert.module';
import { IndicatorModule } from '../indicator/indicator.module';
import { SmcModule } from '../smc/smc.module';

@Module({
  imports: [
    WatchlistModule,
    MacroModule,
    GoldModule,
    forwardRef(() => AlertModule),
    forwardRef(() => IndicatorModule),
    forwardRef(() => SmcModule),
  ],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
