import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type CachedBias = 'BOTH' | 'BUY_ONLY' | 'SELL_ONLY';

export interface CachedSubscriber {
  chatId: string;
  bbAtrAlertEnabled: boolean;
  bbTier0AlertEnabled: boolean;
  bbAtrBias: CachedBias;
  nweAlertEnabled: boolean;
  nweTimeframes: string[];
  smcAlertEnabled: boolean;
  smcTimeframes: string[];
  tier2AlertEnabled: boolean;
}

const DEFAULT_TFS = ['M5', 'M15', 'H1', 'H4'];
const VALID_BIAS = ['BOTH', 'BUY_ONLY', 'SELL_ONLY'];

export function defaultSubscriber(chatId: string): CachedSubscriber {
  return {
    chatId,
    bbAtrAlertEnabled: true,
    bbTier0AlertEnabled: true,
    bbAtrBias: 'BOTH',
    nweAlertEnabled: true,
    nweTimeframes: [...DEFAULT_TFS],
    smcAlertEnabled: true,
    smcTimeframes: [...DEFAULT_TFS],
    tier2AlertEnabled: true,
  };
}

/**
 * Cache RAM danh sách TelegramUser + cờ cảnh báo để đường gửi alert không phải query DB.
 * - Nạp khi boot, refresh định kỳ (stale-while-error: DB lỗi thì giữ cache cũ)
 * - patch()/ensure() được gọi đồng bộ ngay khi user đổi cài đặt / đăng ký
 */
@Injectable()
export class SubscriberCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriberCacheService.name);
  private map = new Map<string, CachedSubscriber>();
  private loaded = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private bootRetryTimer: NodeJS.Timeout | null = null;
  private isDestroyed = false;
  private readonly REFRESH_INTERVAL_MS = 5 * 60_000;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    this.isDestroyed = false;
    await this.tryInitialLoad();
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((e) => this.logger.warn(`Refresh SubscriberCache thất bại: ${e.message}`));
    }, this.REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.bootRetryTimer) clearTimeout(this.bootRetryTimer);
    this.refreshTimer = null;
    this.bootRetryTimer = null;
  }

  private async tryInitialLoad() {
    try {
      await this.refresh();
    } catch (e: any) {
      this.logger.warn(`Nạp SubscriberCache lần đầu thất bại: ${e.message}. Thử lại sau 5s (đang dùng đường DB).`);
      if (this.isDestroyed) return;
      this.bootRetryTimer = setTimeout(() => {
        this.bootRetryTimer = null;
        void this.tryInitialLoad();
      }, 5000);
      this.bootRetryTimer.unref?.();
    }
  }

  isReady(): boolean {
    return this.loaded;
  }

  getAll(): CachedSubscriber[] {
    return Array.from(this.map.values());
  }

  get(chatId: string): CachedSubscriber | undefined {
    return this.map.get(chatId);
  }

  /** Cập nhật đồng bộ khi user đổi cài đặt. Tạo mới (mặc định) nếu chưa có. */
  patch(chatId: string, p: Partial<Omit<CachedSubscriber, 'chatId'>>) {
    if (!chatId) return;
    const cur = this.map.get(chatId) ?? defaultSubscriber(chatId);
    this.map.set(chatId, { ...cur, ...p, chatId });
  }

  /** Đảm bảo user mới có mặt trong cache (mặc định bật hết). */
  ensure(chatId: string) {
    if (chatId && !this.map.has(chatId)) {
      this.map.set(chatId, defaultSubscriber(chatId));
    }
  }

  async refresh(): Promise<void> {
    let rows: any[];
    try {
      rows = await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.findMany({
          select: {
            chatId: true,
            bbAtrAlertEnabled: true,
            bbTier0AlertEnabled: true,
            bbAtrBias: true,
            nweAlertEnabled: true,
            nweTimeframes: true,
            smcAlertEnabled: true,
            smcTimeframes: true,
            tier2AlertEnabled: true,
          },
        }),
      );
    } catch (colErr: any) {
      // Cột bbTier0AlertEnabled có thể chưa được push lên DB production
      rows = await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.findMany({
          select: {
            chatId: true,
            bbAtrAlertEnabled: true,
            bbAtrBias: true,
            nweAlertEnabled: true,
            nweTimeframes: true,
            smcAlertEnabled: true,
            smcTimeframes: true,
            tier2AlertEnabled: true,
          },
        }),
      );
    }

    const next = new Map<string, CachedSubscriber>();
    for (const u of rows) {
      next.set(u.chatId, {
        chatId: u.chatId,
        bbAtrAlertEnabled: u.bbAtrAlertEnabled !== false,
        bbTier0AlertEnabled: u.bbTier0AlertEnabled !== false,
        bbAtrBias: VALID_BIAS.includes(u.bbAtrBias) ? u.bbAtrBias : 'BOTH',
        nweAlertEnabled: u.nweAlertEnabled ?? true,
        nweTimeframes: Array.isArray(u.nweTimeframes) ? [...u.nweTimeframes] : [...DEFAULT_TFS],
        smcAlertEnabled: u.smcAlertEnabled ?? true,
        smcTimeframes: Array.isArray(u.smcTimeframes) ? [...u.smcTimeframes] : [...DEFAULT_TFS],
        tier2AlertEnabled: u.tier2AlertEnabled ?? true,
      });
    }
    this.map = next; // thay nguyên tử
    this.loaded = true;
    this.logger.log(`🧠 SubscriberCache đã đồng bộ ${next.size} user.`);
  }
}
