import { Global, Module } from '@nestjs/common';
import { SubscriberCacheService } from './subscriber-cache.service';

@Global()
@Module({
  providers: [SubscriberCacheService],
  exports: [SubscriberCacheService],
})
export class SubscriberCacheModule {}
