import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export type CallAlertReason = 'TIER_SSS' | 'SMC_TIER_3';

export interface CallMeBotTriggerParams {
  reason: CallAlertReason;
  direction: 'BUY' | 'SELL';
  price: number;
  slPrice?: number;
  detailText?: string;
  bypassCooldown?: boolean;
}

@Injectable()
export class CallMeBotService {
  private readonly logger = new Logger(CallMeBotService.name);

  // Chống gọi dồn dập cho cùng 1 user (CallMeBot yêu cầu giãn cách tối thiểu giữa các cuộc gọi)
  private readonly lastCallTimeByUser = new Map<string, number>();

  constructor(@Optional() private readonly configService?: ConfigService) {}

  private getConfigValue(key: string, fallback = ''): string {
    const fromConfig = this.configService?.get<string>(key);
    const raw = fromConfig !== undefined ? String(fromConfig) : process.env[key];
    return (raw ?? fallback).trim();
  }

  /**
   * Đọc danh sách username / số điện thoại Telegram đã cấp quyền với @CallMeBot_txtbot
   * Hỗ trợ CALLMEBOT_USERS="@user1,@user2" hoặc CALLMEBOT_USER="@user1"
   */
  getConfiguredUsers(): string[] {
    const enabledRaw = this.getConfigValue('CALLMEBOT_ENABLED', 'true').toLowerCase();
    if (enabledRaw === 'false' || enabledRaw === '0' || enabledRaw === 'off') {
      return [];
    }

    const usersRaw =
      this.getConfigValue('CALLMEBOT_USERS') || this.getConfigValue('CALLMEBOT_USER');
    if (!usersRaw) {
      return [];
    }

    return usersRaw
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
  }

  /**
   * Tạo nội dung giọng nói ngắn gọn (tối đa 250 ký tự theo giới hạn CallMeBot TTS)
   */
  buildSpokenMessage(params: CallMeBotTriggerParams): string {
    const dirVn = params.direction === 'SELL' ? 'Bán' : 'Mua';
    const priceStr = Number(params.price).toFixed(1);
    const slPart =
      params.slPrice !== undefined ? `, cắt lỗ ${Number(params.slPrice).toFixed(1)}` : '';

    let text: string;
    if (params.reason === 'TIER_SSS') {
      text = `Cảnh báo khẩn cấp! Vàng đạt siêu hợp lưu Tier S S S! Canh ${dirVn} tại giá ${priceStr}${slPart}. Kiểm tra Telegram ngay!`;
    } else {
      const extra = params.detailText ? ` ${params.detailText}` : '';
      text = `Cảnh báo V I P! Vàng đạt Tier 3 S M C và N W E${extra}! Canh ${dirVn} tại giá ${priceStr}${slPart}. Kiểm tra Telegram ngay!`;
    }

    return text.length > 250 ? text.slice(0, 247) + '...' : text;
  }

  /**
   * Gọi điện Telegram qua CallMeBot API (`https://api.callmebot.com/start.php`)
   * CHỈ được gọi cho 2 trường hợp: TIER_SSS và SMC_TIER_3.
   */
  async triggerVoiceCall(params: CallMeBotTriggerParams): Promise<number> {
    const users = this.getConfiguredUsers();
    if (users.length === 0) {
      this.logger.debug(
        `[CallMeBot] Chưa cấu hình CALLMEBOT_USERS (hoặc CALLMEBOT_ENABLED=false) -> bỏ qua cuộc gọi ${params.reason}.`,
      );
      return 0;
    }

    const lang = this.getConfigValue('CALLMEBOT_LANG', 'vi-VN-Standard-A');
    const rpt = this.getConfigValue('CALLMEBOT_REPEAT', '2');
    const cc = this.getConfigValue('CALLMEBOT_CC', 'missed');
    const cooldownMs =
      Math.max(15, Number(this.getConfigValue('CALLMEBOT_COOLDOWN_SEC', '60')) || 60) * 1000;

    const spokenText = this.buildSpokenMessage(params);
    const now = Date.now();

    const eligibleUsers = users.filter((user) => {
      if (params.bypassCooldown) return true;
      const lastTime = this.lastCallTimeByUser.get(user) || 0;
      if (now - lastTime < cooldownMs) {
        this.logger.debug(
          `[CallMeBot] Bỏ qua gọi ${user} do đang trong cooldown ${Math.round(cooldownMs / 1000)}s.`,
        );
        return false;
      }
      return true;
    });

    if (eligibleUsers.length === 0) {
      return 0;
    }

    let calledCount = 0;

    const results = await Promise.allSettled(
      eligibleUsers.map(async (user) => {
        this.lastCallTimeByUser.set(user, now);
        const url =
          `https://api.callmebot.com/start.php` +
          `?user=${encodeURIComponent(user)}` +
          `&text=${encodeURIComponent(spokenText)}` +
          `&lang=${encodeURIComponent(lang)}` +
          `&rpt=${encodeURIComponent(rpt)}` +
          `&cc=${encodeURIComponent(cc)}`;

        const res = await axios.get(url, { timeout: 10000 });
        return { user, status: res.status };
      }),
    );

    results.forEach((res, idx) => {
      const targetUser = eligibleUsers[idx];
      if (res.status === 'fulfilled') {
        calledCount++;
        this.logger.log(
          `📞 [CallMeBot ${params.reason}] Đã kích hoạt cuộc gọi Telegram tới ${targetUser} (${params.direction} @ $${params.price.toFixed(2)})!`,
        );
      } else {
        const reasonMsg = res.reason?.message || String(res.reason);
        this.logger.warn(`⚠️ [CallMeBot] Lỗi gọi điện tới ${targetUser}: ${reasonMsg}`);
      }
    });

    return calledCount;
  }
}
