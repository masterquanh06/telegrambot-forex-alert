import { Injectable, Logger, Inject, Optional, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriberCacheService, isTierEnabledForSubscriber } from './subscriber-cache.service';
import { TelegramService } from '../telegram/telegram.service';
import { CallMeBotService } from './callmebot.service';
import {
  evaluateTierSss,
  shouldSuppressDuplicateSss,
  SSS_CONFLUENCE_WINDOW_MS,
  SSS_COOLDOWN_MS,
  SssDedupState,
  Tier3EventPayload,
  TierSssResult,
} from '../indicator/super-tier-classifier';

@Injectable()
export class SuperTierService {
  private readonly logger = new Logger(SuperTierService.name);

  // Lưu sự kiện Tier 3 gần nhất của mỗi nguồn (in-memory) cho XAU/USD
  private latestBbTier3: Tier3EventPayload | null = null;
  private latestSmcTier3: Tier3EventPayload | null = null;

  // Trạng thái chống bắn trùng Tier SSS
  private dedupState: SssDedupState = {};

  // Khóa chống race condition khi BB và SMC báo cáo gần như đồng thời
  private isBroadcastingSss = false;
  private pendingReeval = false;

  // Fallback chatIds khi DB tạm gián đoạn
  private readonly activeChatIds = new Set<string>(['5513976350']);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TelegramService))
    private readonly telegramService: TelegramService,
    @Optional()
    private readonly callMeBotService?: CallMeBotService,
    @Optional()
    private readonly subscriberCache?: SubscriberCacheService,
  ) {}

  registerActiveChat(chatId: string) {
    if (chatId) {
      this.activeChatIds.add(chatId);
    }
  }

  /**
   * Nhận báo cáo sự kiện Tier 3 từ BbAtrService hoặc SmcService.
   * Luôn cập nhật state mới nhất TRƯỚC khi kiểm tra khóa `isBroadcastingSss` để không làm rơi event.
   */
  async reportTier3Event(event: Tier3EventPayload): Promise<boolean> {
    if (event.source === 'BB_ATR') {
      this.latestBbTier3 = event;
    } else if (event.source === 'SMC_NWE') {
      this.latestSmcTier3 = event;
    }

    if (this.isBroadcastingSss) {
      this.pendingReeval = true;
      return false;
    }

    this.isBroadcastingSss = true;
    let anySent = false;

    try {
      do {
        this.pendingReeval = false;
        const sent = await this.evaluateAndBroadcastSss();
        if (sent) anySent = true;
      } while (this.pendingReeval);

      return anySent;
    } catch (err: any) {
      this.logger.error(`Lỗi trong SuperTierService.reportTier3Event: ${err.message}`);
      return anySent;
    } finally {
      this.isBroadcastingSss = false;
    }
  }

  private async evaluateAndBroadcastSss(): Promise<boolean> {
    const result = evaluateTierSss(
      this.latestBbTier3,
      this.latestSmcTier3,
      SSS_CONFLUENCE_WINDOW_MS,
    );

    if (!result) {
      return false;
    }

    const now = Date.now();
    if (shouldSuppressDuplicateSss(result, this.dedupState, now, SSS_COOLDOWN_MS)) {
      return false;
    }

    // Chốt state chống trùng ngay trước khi broadcast
    this.dedupState = {
      lastSssKey: result.sssKey,
      lastSssDirection: result.direction,
      lastSssAlertTime: now,
    };

    const chatIds = await this.getAllVipSubscribers();
    if (chatIds.length === 0) {
      this.logger.warn('⚠️ Đạt TIER SSS nhưng chưa tìm thấy người dùng nhận tin VIP.');
      return false;
    }

    const alertMsg = this.renderTierSssMessage(result);
    const sentCount = await this.broadcastTelegramInBatches(
      chatIds,
      alertMsg,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 Bảng BB+ATR M5', callback_data: 'bbatr_view:XAU:M5' },
              { text: '🌊 Bảng NWE H1', callback_data: 'nwe_view:H1' },
            ],
            [
              { text: '🧱 Bảng Order Block H1', callback_data: 'ob_view:H1' },
            ],
          ],
        },
      },
      25,
    );

    if (sentCount > 0) {
      this.logger.log(
        `👑💎🔥🔥🔥 [TIER SSS ALERT] ${result.direction} XAU/USD tại $${result.entryPrice.toFixed(2)} (SL an toàn: $${result.safestSl.toFixed(2)} | Độ trễ: ${result.timeDiffMinutes} phút) -> Đã gửi tới ${sentCount} người dùng VIP.`,
      );

      // Gọi điện báo thức Telegram qua CallMeBot ngay khi đạt TIER SSS
      if (this.callMeBotService) {
        this.callMeBotService
          .triggerVoiceCall({
            reason: 'TIER_SSS',
            direction: result.direction,
            price: result.entryPrice,
            slPrice: result.safestSl,
          })
          .catch((err) => {
            this.logger.warn(`Lỗi kích hoạt CallMeBot TIER SSS: ${err.message}`);
          });
      }

      return true;
    }

    return false;
  }

  /**
   * Lấy toàn bộ người dùng đang bật TIER SSS (tách biệt với Tier 3; fallback tier2AlertEnabled nếu record cũ)
   */
  private async getAllVipSubscribers(): Promise<string[]> {
    const chatIds: string[] = [];
    const knownDbChatIds = new Set<string>();

    try {
      let users: any[];
      if (this.subscriberCache?.isReady()) {
        users = this.subscriberCache.getAll();
      } else {
        try {
          users = await this.prisma.executeWithRetry(() =>
            this.prisma.telegramUser.findMany({
              select: { chatId: true, tierSssAlertEnabled: true, tier2AlertEnabled: true },
            }),
          );
        } catch (colErr) {
          users = await this.prisma.executeWithRetry(() =>
            this.prisma.telegramUser.findMany({
              select: { chatId: true, tier2AlertEnabled: true },
            }),
          );
        }
      }

      if (users && users.length > 0) {
        for (const u of users) {
          knownDbChatIds.add(u.chatId);
          if (isTierEnabledForSubscriber(u, 'SSS')) {
            chatIds.push(u.chatId);
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`Lỗi đọc danh sách VIP subscribers cho TIER SSS: ${err.message}`);
    }

    for (const chatId of this.activeChatIds) {
      if (!knownDbChatIds.has(chatId)) {
        chatIds.push(chatId);
      }
    }

    return chatIds;
  }

  /**
   * Broadcast song song theo batch 25 users/lượt dùng Promise.allSettled()
   */
  private async broadcastTelegramInBatches(
    chatIds: string[],
    message: string,
    extra?: any,
    batchSize = 25,
  ): Promise<number> {
    let sentCount = 0;

    for (let i = 0; i < chatIds.length; i += batchSize) {
      const batch = chatIds.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((chatId) => this.telegramService.sendMessage(chatId, message, extra)),
      );

      results.forEach((res, idx) => {
        if (res.status === 'fulfilled' && res.value !== false) {
          sentCount++;
        } else {
          const failedChatId = batch[idx];
          const reasonMsg =
            res.status === 'rejected'
              ? res.reason?.message || String(res.reason)
              : 'sendMessage trả về false';
          this.logger.warn(`Lỗi gửi TIER SSS tới chatId=${failedChatId}: ${reasonMsg}`);
        }
      });
    }

    return sentCount;
  }

  private escapeHtml(text: string): string {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private formatDelayText(timeDiffMs: number): string {
    const totalSec = Math.round(timeDiffMs / 1000);
    if (totalSec < 60) {
      return `${totalSec} giây`;
    }
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return secs > 0 ? `${mins} phút ${secs} giây` : `${mins} phút`;
  }

  /**
   * Render tin nhắn Telegram cực kỳ nổi bật, đọc nhanh < 2 giây, 1 chạm copy và an toàn parse_mode HTML cho TIER SSS
   */
  renderTierSssMessage(result: TierSssResult): string {
    const isSell = result.direction === 'SELL';
    const dirEmoji = isSell ? '🔴🔴' : '🟢🟢';
    const dirAction = isSell ? 'SELL' : 'BUY';

    const nowStr = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(result.triggeredAtMs));

    const delayText = this.formatDelayText(result.timeDiffMs);
    const bbDetails = result.bbEvent.details || {};
    const smcDetails = result.smcEvent.details || {};

    const bbEntryLevel = isSell ? bbDetails.upperEntry : bbDetails.lowerEntry;
    const bbAtrText = bbDetails.atrM5 !== undefined ? Number(bbDetails.atrM5).toFixed(2) : 'N/A';
    const bbRsiText = bbDetails.rsiValue !== undefined ? Number(bbDetails.rsiValue).toFixed(2) : 'N/A';

    const nweBand = isSell ? smcDetails.nweH1?.upperBand : smcDetails.nweH1?.lowerBand;
    const primaryOb = smcDetails.primaryOb;
    const matchedObs: Array<{ timeframe: string; bottom: number; top: number; label?: string }> =
      Array.isArray(smcDetails.matchedOrderBlocks) ? smcDetails.matchedOrderBlocks : [];
    const obTfList =
      matchedObs.length > 0
        ? Array.from(new Set(matchedObs.map((o) => o.timeframe))).join('+')
        : primaryOb?.timeframe || 'M15/H1';
    const smcAtrText = smcDetails.atrM15 !== undefined ? Number(smcDetails.atrM15).toFixed(2) : 'N/A';

    const slDistance = Math.abs(result.entryPrice - result.safestSl);

    let msg = `👑💎🔥🔥🔥 ${dirEmoji} <b>${dirAction} XAU/USD • TIER SSS</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🎯 <b>ENTRY:</b> <code>${result.entryPrice.toFixed(2)}</code> <i>(Hợp lưu BB M5 + SMC M15)</i>\n`;
    msg += `🛑 <b>SL AN TOÀN:</b> <code>${result.safestSl.toFixed(2)}</code> <b>(-${slDistance.toFixed(2)})</b> <i>· Hợp nhất 2 hệ thống</i>\n`;
    if (result.tp1Price !== undefined) {
      const tp1Diff = isSell ? result.entryPrice - result.tp1Price : result.tp1Price - result.entryPrice;
      const tp1Sign = tp1Diff >= 0 ? '+' : '-';
      const tp1RR = slDistance > 0 ? (Math.abs(tp1Diff) / slDistance).toFixed(1) : '0.0';
      msg += `✅ <b>TP1:</b> <code>${result.tp1Price.toFixed(2)}</code> <i>(${tp1Sign}${Math.abs(tp1Diff).toFixed(2)} · BB Mid M5 · 1:${tp1RR})</i>\n`;
    }
    if (result.tp2Price !== undefined) {
      const tp2Diff = isSell ? result.entryPrice - result.tp2Price : result.tp2Price - result.entryPrice;
      const tp2Sign = tp2Diff >= 0 ? '+' : '-';
      const tp2RR = slDistance > 0 ? (Math.abs(tp2Diff) / slDistance).toFixed(1) : '0.0';
      msg += `✅ <b>TP2:</b> <code>${result.tp2Price.toFixed(2)}</code> <i>(${tp2Sign}${Math.abs(tp2Diff).toFixed(2)} · NWE H1 Kernel · 1:${tp2RR})</i>\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;

    let pillar1 = `🏛 <b>BB+ATR M5 (T3):</b> `;
    if (bbEntryLevel !== undefined) {
      pillar1 += `Entry <code>${Number(bbEntryLevel).toFixed(2)}</code> · `;
    }
    pillar1 += `SL <code>${result.bbEvent.slPrice.toFixed(2)}</code> · ATR <code>${bbAtrText}</code> · RSI <code>${bbRsiText}</code>\n`;

    let pillar2 = `🏛 <b>SMC/NWE M15 (T3):</b> `;
    if (nweBand !== undefined) {
      pillar2 += `NWE H1 <code>${Number(nweBand).toFixed(2)}</code> · `;
    }
    if (primaryOb) {
      pillar2 += `OB (${this.escapeHtml(obTfList)}) <code>${Number(primaryOb.bottom).toFixed(2)}</code>–<code>${Number(primaryOb.top).toFixed(2)}</code> · `;
    }
    pillar2 += `SL <code>${result.smcEvent.slPrice.toFixed(2)}</code> · ATR <code>${smcAtrText}</code>\n`;

    msg += pillar1;
    msg += pillar2;
    msg += `⏱ <b>Hội tụ:</b> <b>${delayText}</b> · 🕒 <code>${nowStr}</code>`;

    return msg;
  }
}
