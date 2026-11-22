import { Module } from '@nestjs/common';
import { LiquiditySweepService } from './liquiditySweep';

@Module({
  providers: [LiquiditySweepService],
  exports: [LiquiditySweepService],
})
export class LiquiditySweepModule {}
