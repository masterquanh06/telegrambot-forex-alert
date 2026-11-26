import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type CachedBias = 'BOTH' | 'BUY_ONLY' | 'SELL_ONLY';
export type AlertTierKey = '0' | '1' | '2' | '3' | 'SSS';

export interface TierAlertSettings {
  tier0: boolean;
  tier1: boolean;
  tier2: boolean;
  tier3: boolean;
  tierSss: boolean;
}

export interface CachedSubscriber {
  chatId: string;
  bbAtrAlertEnabled: boolean;
  bbTier0AlertEnabled: boolean;
  tier1AlertEnabled: boolean;
  tier2SignalEnabled: boolean;
  tier3AlertEnabled: boolean;
  tierSssAlertEnabled: boolean;
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
    tier1AlertEnabled: true,
    tier2SignalEnabled: true,
    tier3AlertEnabled: true,
    tierSssAlertEnabled: true,
    bbAtrBias: 'BOTH',
    nweAlertEnabled: true,
    nweTimeframes: [...DEFAULT_TFS],
    smcAlertEnabled: true,
    smcTimeframes: [...DEFAULT_TFS],
    tier2AlertEnabled: true,
  };
}

export type TierFlagsInput = Partial<
  Pick<
    CachedSubscriber,
    | 'bbTier0AlertEnabled'
    | 'tier1AlertEnabled'
    | 'tier2SignalEnabled'
    | 'tier3AlertEnabled'
    | 'tierSssAlertEnabled'
    | 'tier2AlertEnabled'
  >
>;

/**
 * Pure helper kiểm tra subscriber có bật nhận thông báo cho Tier tương ứng hay không.
 * - Tách bạch độc lập giữa Tier 0, 1, 2, 3, SSS.
 * - Giữ tương thích ngược với record/mock cũ chỉ có `tier2AlertEnabled`.
 */
export function isTierEnabledForSubscriber(
  sub: TierFlagsInput,
  tier: AlertTierKey,
): boolean {
  switch (tier) {
    case '0':
      return sub.bbTier0AlertEnabled !== false;
    case '1':
      return sub.tier1AlertEnabled !== false;
    case '2':
      return sub.tier2SignalEnabled !== false;
    case '3':
      return sub.tier3AlertEnabled !== undefined
        ? sub.tier3AlertEnabled !== false
        : sub.tier2AlertEnabled !== false;
    case 'SSS':
      return sub.tierSssAlertEnabled !== undefined
        ? sub.tierSssAlertEnabled !== false
        : sub.tier2AlertEnabled !== false;
  }
}

/**
 * Cache RAM danh sách TelegramUser + cờ cảnh báo để đường gửi alert không phải query DB.
 * - Nạp khi boot, refresh định kỳ (stale-while-error: DB lỗi thì giữ cache cũ)
 * - patch()/ensure()/toggleTier() được gọi đồng bộ ngay khi user đổi cài đặt / đăng ký
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

  /**
   * Lấy cấu hình bật/tắt chi tiết từng Tier của 1 user (ưu tiên RAM cache).
   */
  async getTierSettings(chatId: string): Promise<TierAlertSettings> {
    const cached = this.map.get(chatId);
    if (cached) {
      return {
        tier0: isTierEnabledForSubscriber(cached, '0'),
        tier1: isTierEnabledForSubscriber(cached, '1'),
        tier2: isTierEnabledForSubscriber(cached, '2'),
        tier3: isTierEnabledForSubscriber(cached, '3'),
        tierSss: isTierEnabledForSubscriber(cached, 'SSS'),
      };
    }

    try {
      const u: any = await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.findUnique({
          where: { chatId },
          select: {
            bbTier0AlertEnabled: true,
            tier1AlertEnabled: true,
            tier2SignalEnabled: true,
            tier3AlertEnabled: true,
            tierSssAlertEnabled: true,
            tier2AlertEnabled: true,
          },
        }),
      );
      if (u) {
        const tier3 = isTierEnabledForSubscriber(u, '3');
        const tierSss = isTierEnabledForSubscriber(u, 'SSS');
        this.patch(chatId, {
          bbTier0AlertEnabled: u.bbTier0AlertEnabled !== false,
          tier1AlertEnabled: u.tier1AlertEnabled !== false,
          tier2SignalEnabled: u.tier2SignalEnabled !== false,
          tier3AlertEnabled: tier3,
          tierSssAlertEnabled: tierSss,
          tier2AlertEnabled: u.tier2AlertEnabled !== false,
        });
        return {
          tier0: u.bbTier0AlertEnabled !== false,
          tier1: u.tier1AlertEnabled !== false,
          tier2: u.tier2SignalEnabled !== false,
          tier3,
          tierSss,
        };
      }
    } catch (e) {
      // Fallback nếu DB chưa migrate cột mới hoặc tạm gián đoạn
    }

    return { tier0: true, tier1: true, tier2: true, tier3: true, tierSss: true };
  }

  /**
   * Đặt trạng thái Bật/Tắt cho một Tier cụ thể: patch RAM ngay lập tức rồi lưu xuống DB.
   */
  async setTierEnabled(
    chatId: string,
    tier: AlertTierKey,
    enabled: boolean,
  ): Promise<TierAlertSettings> {
    const patchData: Partial<Omit<CachedSubscriber, 'chatId'>> = {};
    const dbData: Record<string, boolean> = {};

    switch (tier) {
      case '0':
        patchData.bbTier0AlertEnabled = enabled;
        dbData.bbTier0AlertEnabled = enabled;
        break;
      case '1':
        patchData.tier1AlertEnabled = enabled;
        dbData.tier1AlertEnabled = enabled;
        break;
      case '2':
        patchData.tier2SignalEnabled = enabled;
        dbData.tier2SignalEnabled = enabled;
        break;
      case '3':
        patchData.tier3AlertEnabled = enabled;
        patchData.tier2AlertEnabled = enabled;
        dbData.tier3AlertEnabled = enabled;
        dbData.tier2AlertEnabled = enabled;
        break;
      case 'SSS':
        patchData.tierSssAlertEnabled = enabled;
        dbData.tierSssAlertEnabled = enabled;
        break;
    }

    this.patch(chatId, patchData);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.upsert({
          where: { chatId },
          update: dbData,
          create: { chatId, ...dbData },
        }),
      );
    } catch (e: any) {
      this.logger.warn(`Lưu cài đặt Tier ${tier} cho chatId=${chatId} thất bại (đã giữ trong RAM): ${e?.message}`);
    }

    return this.getTierSettings(chatId);
  }

  /**
   * Đảo trạng thái Bật/Tắt của một Tier cụ thể.
   */
  async toggleTier(
    chatId: string,
    tier: AlertTierKey,
  ): Promise<{ enabled: boolean; settings: TierAlertSettings }> {
    const current = await this.getTierSettings(chatId);
    const curVal =
      tier === '0'
        ? current.tier0
        : tier === '1'
        ? current.tier1
        : tier === '2'
        ? current.tier2
        : tier === '3'
        ? current.tier3
        : current.tierSss;
    const next = !curVal;
    const settings = await this.setTierEnabled(chatId, tier, next);
    return { enabled: next, settings };
  }

  /**
   * Áp nhanh preset cài đặt Tier (Bật tất cả hoặc Chỉ VIP: Tier 3 + Tier SSS).
   */
  async applyTierPreset(
    chatId: string,
    preset: 'ALL' | 'VIP_ONLY',
  ): Promise<TierAlertSettings> {
    const isAll = preset === 'ALL';
    const patchData: Partial<Omit<CachedSubscriber, 'chatId'>> = {
      bbTier0AlertEnabled: isAll,
      tier1AlertEnabled: isAll,
      tier2SignalEnabled: isAll,
      tier3AlertEnabled: true,
      tierSssAlertEnabled: true,
      tier2AlertEnabled: true,
    };

    this.patch(chatId, patchData);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.upsert({
          where: { chatId },
          update: patchData,
          create: { chatId, ...patchData },
        }),
      );
    } catch (e: any) {
      this.logger.warn(`Lưu preset Tier ${preset} cho chatId=${chatId} thất bại (đã giữ trong RAM): ${e?.message}`);
    }

    return this.getTierSettings(chatId);
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
            tier1AlertEnabled: true,
            tier2SignalEnabled: true,
            tier3AlertEnabled: true,
            tierSssAlertEnabled: true,
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
      // Fallback an toàn nếu các cột Tier mới chưa được push lên DB production
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
      } catch (legacyErr: any) {
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
    }

    const next = new Map<string, CachedSubscriber>();
    for (const u of rows) {
      const legacyVip = u.tier2AlertEnabled !== false;
      next.set(u.chatId, {
        chatId: u.chatId,
        bbAtrAlertEnabled: u.bbAtrAlertEnabled !== false,
        bbTier0AlertEnabled: u.bbTier0AlertEnabled !== false,
        tier1AlertEnabled: u.tier1AlertEnabled !== false,
        tier2SignalEnabled: u.tier2SignalEnabled !== false,
        tier3AlertEnabled: u.tier3AlertEnabled !== undefined ? u.tier3AlertEnabled !== false : legacyVip,
        tierSssAlertEnabled: u.tierSssAlertEnabled !== undefined ? u.tierSssAlertEnabled !== false : legacyVip,
        bbAtrBias: VALID_BIAS.includes(u.bbAtrBias) ? u.bbAtrBias : 'BOTH',
        nweAlertEnabled: u.nweAlertEnabled ?? true,
        nweTimeframes: Array.isArray(u.nweTimeframes) ? [...u.nweTimeframes] : [...DEFAULT_TFS],
        smcAlertEnabled: u.smcAlertEnabled ?? true,
        smcTimeframes: Array.isArray(u.smcTimeframes) ? [...u.smcTimeframes] : [...DEFAULT_TFS],
        tier2AlertEnabled: legacyVip,
      });
    }
    this.map = next; // thay nguyên tử
    this.loaded = true;
    this.logger.log(`🧠 SubscriberCache đã đồng bộ ${next.size} user.`);
  }
}
