import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import {
  SmcTimeframe,
  NweEnvelope,
  OrderBlock,
  KeyLevel,
  SmcSignalType,
  SmcAnalysisResult,
  UserSmcSettings,
} from './smc.interface';
import { CandleData } from '../indicator/bb-atr.interface';
import { LiquiditySweepService, SweepSignal } from '../services/liquiditySweep';

@Injectable()
export class SmcService {
  private readonly logger = new Logger(SmcService.name);

  // Cache nến klines theo khung thời gian (8 giây)
  private readonly klinesCache = new Map<string, { candles: CandleData[]; time: number }>();

  // Cache kết quả phân tích theo khung thời gian (6 giây)
  private readonly analysisCache = new Map<string, { result: SmcAnalysisResult; time: number }>();

  // State chống spam cảnh báo cho từng khung thời gian
  private readonly tfAlertStateMap = new Map<
    string,
    {
      lastSignal: SmcSignalType;
      lastAlertTime: number;
      lastPrice: number;
    }
  >();

  // In-memory fallback cho cấu hình người dùng phòng khi DB gián đoạn
  private readonly userSettingsFallback = new Map<string, UserSmcSettings>();
  private readonly activeChatIds = new Set<string>(['5513976350']);

  readonly supportedTimeframes: SmcTimeframe[] = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

  readonly timeframeLabels: Record<SmcTimeframe, string> = {
    M1: '1 Phút (M1)',
    M5: '5 Phút (M5)',
    M15: '15 Phút (M15)',
    M30: '30 Phút (M30)',
    H1: '1 Giờ (H1)',
    H4: '4 Giờ (H4)',
    D1: '1 Ngày (D1)',
  };

  readonly binanceIntervalMap: Record<SmcTimeframe, string> = {
    M1: '1m',
    M5: '5m',
    M15: '15m',
    M30: '30m',
    H1: '1h',
    H4: '4h',
    D1: '1d',
  };

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TelegramService))
    private readonly telegramService: TelegramService,
    private readonly liquiditySweepService: LiquiditySweepService,
  ) {}

  registerActiveChat(chatId: string) {
    if (chatId) {
      this.activeChatIds.add(chatId);
    }
  }

  /**
   * Tải dữ liệu nến cho Vàng (XAU/USD) theo khung thời gian
   */
  async fetchCandles(timeframe: SmcTimeframe = 'M15', limit = 100): Promise<CandleData[]> {
    const cacheKey = `XAU:${timeframe}`;
    const now = Date.now();

    if (this.klinesCache.has(cacheKey)) {
      const cached = this.klinesCache.get(cacheKey)!;
      if (now - cached.time < 8000) {
        return cached.candles;
      }
    }

    const interval = this.binanceIntervalMap[timeframe] || '15m';

    try {
      const res = await axios.get(
        `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${interval}&limit=${limit}`,
        { timeout: 6000 },
      );

      if (Array.isArray(res.data) && res.data.length > 0) {
        const candles: CandleData[] = res.data.map((k: any) => ({
          time: Number(k[0]),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }));

        this.klinesCache.set(cacheKey, { candles, time: now });
        return candles;
      }
    } catch (err: any) {
      this.logger.warn(`Lỗi tải nến XAU khung ${timeframe}: ${err.message}`);
    }

    if (this.klinesCache.has(cacheKey)) {
      return this.klinesCache.get(cacheKey)!.candles;
    }

    throw new Error(`Không thể lấy dữ liệu nến cho khung ${timeframe}`);
  }

  /**
   * 1. TÍNH TOÁN DẢI NADARAYA-WATSON ENVELOPE + DYNAMIC S/R (NWE)
   * Theo đúng công thức Gaussian Kernel Regression & LuxAlgo NWE
   * Tham số: Bandwidth (h = 8), Multiplier (mult = 3.0)
   */
  calculateNwe(candles: CandleData[], h = 8, mult = 3.0): NweEnvelope {
    const n = candles.length;
    if (n < 20) {
      const last = candles[n - 1] || { close: 0, high: 0, low: 0 };
      return {
        kernel: last.close,
        upperBand: last.close,
        lowerBand: last.close,
        mae: 0,
        dynamicResistance: last.high,
        dynamicSupport: last.low,
        isTouchUpper: false,
        isTouchLower: false,
      };
    }

    const windowSize = Math.min(n, 50);
    const weights: number[] = [];
    let sumWeights = 0;

    for (let i = 0; i < windowSize; i++) {
      const w = Math.exp(-(i * i) / (2 * h * h));
      weights.push(w);
      sumWeights += w;
    }

    let sumY = 0;
    for (let i = 0; i < windowSize; i++) {
      const c = candles[n - 1 - i];
      sumY += c.close * weights[i];
    }
    const kernelValue = sumY / sumWeights;

    let sumDiff = 0;
    for (let i = 0; i < windowSize; i++) {
      const c = candles[n - 1 - i];
      sumDiff += Math.abs(c.close - kernelValue);
    }
    const mae = sumDiff / windowSize;

    const upperBand = kernelValue + mult * mae;
    const lowerBand = kernelValue - mult * mae;

    // Dynamic S/R: Tìm các đỉnh và đáy cục bộ trong 20 nến gần nhất
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    const lookbackSR = Math.min(n, 20);
    for (let i = n - lookbackSR; i < n; i++) {
      if (candles[i].high > highestHigh) highestHigh = candles[i].high;
      if (candles[i].low < lowestLow) lowestLow = candles[i].low;
    }

    const current = candles[n - 1];
    const isTouchUpper = current.high >= upperBand || current.close >= upperBand;
    const isTouchLower = current.low <= lowerBand || current.close <= lowerBand;

    return {
      kernel: Number(kernelValue.toFixed(2)),
      upperBand: Number(upperBand.toFixed(2)),
      lowerBand: Number(lowerBand.toFixed(2)),
      mae: Number(mae.toFixed(2)),
      dynamicResistance: Number(highestHigh.toFixed(2)),
      dynamicSupport: Number(lowestLow.toFixed(2)),
      isTouchUpper,
      isTouchLower,
    };
  }

  /**
   * 2. NHẬN DIỆN VÙNG SUPPLY & DEMAND (ORDER BLOCKS) & KEY S/R THEO SMC
   */
  detectOrderBlocks(
    candles: CandleData[],
    timeframe: SmcTimeframe,
  ): {
    activeDemand: OrderBlock[];
    activeSupply: OrderBlock[];
    keyLevels: KeyLevel[];
    touchingDemand: OrderBlock | null;
    touchingSupply: OrderBlock | null;
  } {
    const n = candles.length;
    if (n < 20) {
      return {
        activeDemand: [],
        activeSupply: [],
        keyLevels: [],
        touchingDemand: null,
        touchingSupply: null,
      };
    }

    const demandZones: OrderBlock[] = [];
    const supplyZones: OrderBlock[] = [];
    const keyLevels: KeyLevel[] = [];

    // Quét tìm Order Block và nhịp phá vỡ cấu trúc (Displacement / BOS)
    for (let i = 2; i < n - 2; i++) {
      const curr = candles[i];
      const next1 = candles[i + 1];

      // Bullish Order Block (Vùng Cầu - Demand): Nến đỏ trước 1 đợt tăng vọt mạnh mẽ
      if (curr.close < curr.open && next1.close > next1.open) {
        const bodyNext = Math.abs(next1.close - next1.open);
        const rangeCurr = curr.high - curr.low;
        const isStrongRally = next1.close > curr.high && bodyNext >= rangeCurr * 0.9;

        if (isStrongRally) {
          demandZones.push({
            id: `dem_${timeframe}_${curr.time}`,
            index: i,
            time: curr.time,
            top: Number(Math.max(curr.open, curr.high).toFixed(2)),
            bottom: Number(curr.low.toFixed(2)),
            type: 'DEMAND',
            label: `Vùng Cầu ${timeframe} (Bullish OB)`,
            timeframe,
            mitigated: false,
          });
        }
      }

      // Bearish Order Block (Vùng Cung - Supply): Nến xanh trước 1 đợt xả mạnh mẽ
      if (curr.close > curr.open && next1.close < next1.open) {
        const bodyNext = Math.abs(next1.close - next1.open);
        const rangeCurr = curr.high - curr.low;
        const isStrongDrop = next1.close < curr.low && bodyNext >= rangeCurr * 0.9;

        if (isStrongDrop) {
          supplyZones.push({
            id: `sup_${timeframe}_${curr.time}`,
            index: i,
            time: curr.time,
            top: Number(curr.high.toFixed(2)),
            bottom: Number(Math.min(curr.open, curr.low).toFixed(2)),
            type: 'SUPPLY',
            label: `Vùng Cung ${timeframe} (Bearish OB)`,
            timeframe,
            mitigated: false,
          });
        }
      }
    }

    // Kiểm tra các vùng đã bị triệt tiêu (Mitigated) bởi các nến sau đó chưa
    for (const zone of demandZones) {
      for (let j = zone.index + 2; j < n; j++) {
        if (candles[j].low <= zone.bottom) {
          zone.mitigated = true;
          break;
        }
      }
    }

    for (const zone of supplyZones) {
      for (let j = zone.index + 2; j < n; j++) {
        if (candles[j].high >= zone.top) {
          zone.mitigated = true;
          break;
        }
      }
    }

    // Giữ lại tối đa 3 vùng Cầu và 3 vùng Cung gần nhất chưa bị vô hiệu
    const activeDemand = demandZones.filter((z) => !z.mitigated).slice(-3);
    const activeSupply = supplyZones.filter((z) => !z.mitigated).slice(-3);

    const currentCandle = candles[n - 1];

    // Xác định xem nến hiện tại có đang chạm vào vùng Cung hoặc Cầu nào không
    let touchingDemand: OrderBlock | null = null;
    for (const d of activeDemand) {
      if (currentCandle.low <= d.top && currentCandle.high >= d.bottom) {
        touchingDemand = d;
        break;
      }
    }

    let touchingSupply: OrderBlock | null = null;
    for (const s of activeSupply) {
      if (currentCandle.high >= s.bottom && currentCandle.low <= s.top) {
        touchingSupply = s;
        break;
      }
    }

    // Tính các mốc Pivot High (PH) và Pivot Low (PL) chính
    let maxHigh = -Infinity;
    let minLow = Infinity;
    for (let i = n - 30; i < n; i++) {
      if (candles[i].high > maxHigh) maxHigh = candles[i].high;
      if (candles[i].low < minLow) minLow = candles[i].low;
    }

    keyLevels.push({
      price: Number(maxHigh.toFixed(2)),
      type: 'HIGHEST',
      label: `Đỉnh cao nhất (PH ${timeframe})`,
      timeframe,
    });

    keyLevels.push({
      price: Number(minLow.toFixed(2)),
      type: 'LOWEST',
      label: `Đáy sâu nhất (PL ${timeframe})`,
      timeframe,
    });

    return {
      activeDemand,
      activeSupply,
      keyLevels,
      touchingDemand,
      touchingSupply,
    };
  }

  /**
   * Phân tích toàn diện SMC & NWE cho 1 khung thời gian
   */
  async analyzeTimeframe(timeframe: SmcTimeframe = 'M15', forceRefresh = false): Promise<SmcAnalysisResult> {
    const cacheKey = `ANALYSIS:XAU:${timeframe}`;
    const now = Date.now();

    if (!forceRefresh && this.analysisCache.has(cacheKey)) {
      const cached = this.analysisCache.get(cacheKey)!;
      if (now - cached.time < 6000) {
        return cached.result;
      }
    }

    const candles = await this.fetchCandles(timeframe, 100);
    const currentCandle = candles[candles.length - 1];
    const currentPrice = currentCandle.close;

    const nwe = this.calculateNwe(candles, 8, 3.0);
    const { activeDemand, activeSupply, keyLevels, touchingDemand, touchingSupply } =
      this.detectOrderBlocks(candles, timeframe);

    let signal: SmcSignalType = 'NORMAL';
    let signalReason = 'Giá đang dao động bình thường giữa các vùng.';

    // Phân cấp tín hiệu
    if (touchingSupply && nwe.isTouchUpper) {
      signal = 'CONFLUENCE_SELL';
      signalReason = `🚨 HỢP LƯU BÁN MẠNH! Giá chạm đồng thời Dải trên Nadaraya-Watson Envelope ($${nwe.upperBand}) VÀ Vùng Cung ${touchingSupply.label} [$${touchingSupply.bottom} - $${touchingSupply.top}].`;
    } else if (touchingDemand && nwe.isTouchLower) {
      signal = 'CONFLUENCE_BUY';
      signalReason = `🚨 HỢP LƯU MUA MẠNH! Giá chạm đồng thời Dải dưới Nadaraya-Watson Envelope ($${nwe.lowerBand}) VÀ Vùng Cầu ${touchingDemand.label} [$${touchingDemand.bottom} - $${touchingDemand.top}].`;
    } else if (touchingSupply) {
      signal = 'TOUCH_SUPPLY_OB';
      signalReason = `🔴 Giá đã tiến vào VÙNG CUNG (Supply Zone / Bearish Order Block) ${touchingSupply.label} [$${touchingSupply.bottom} - $${touchingSupply.top}].`;
    } else if (touchingDemand) {
      signal = 'TOUCH_DEMAND_OB';
      signalReason = `🟢 Giá đã rơi vào VÙNG CẦU (Demand Zone / Bullish Order Block) ${touchingDemand.label} [$${touchingDemand.bottom} - $${touchingDemand.top}].`;
    } else if (nwe.isTouchUpper) {
      signal = 'TOUCH_NWE_UPPER';
      signalReason = `🔴 Giá chạm/vượt dải trên Nadaraya-Watson Envelope ($${nwe.upperBand}) [Kháng cự động: $${nwe.dynamicResistance}].`;
    } else if (nwe.isTouchLower) {
      signal = 'TOUCH_NWE_LOWER';
      signalReason = `🟢 Giá chạm/thủng dải dưới Nadaraya-Watson Envelope ($${nwe.lowerBand}) [Hỗ trợ động: $${nwe.dynamicSupport}].`;
    }

    // KIỂM TRA QUÉT THANH KHOẢN (LIQUIDITY SWEEP) CHO TÍN HIỆU SMC / NWE
    let sweepSignal: SweepSignal = { hasSweep: false };
    let alertTier: 1 | 2 = 1;

    if (signal !== 'NORMAL') {
      const isSellSide =
        signal === 'CONFLUENCE_SELL' ||
        signal === 'TOUCH_SUPPLY_OB' ||
        signal === 'TOUCH_NWE_UPPER';
      const expectedDirection = isSellSide ? 'SELL' : 'BUY';

      try {
        const m15Candles = timeframe === 'M15' ? candles : await this.fetchCandles('M15', 100);
        sweepSignal = this.liquiditySweepService.checkRecentSweep(
          candles,
          m15Candles,
          expectedDirection,
        );
        if (sweepSignal.hasSweep) {
          alertTier = 2;
        }
      } catch (e: any) {
        this.logger.debug(`Lỗi kiểm tra liquidity sweep trong SMC: ${e.message}`);
      }
    }

    const result: SmcAnalysisResult = {
      symbol: 'XAU',
      displaySymbol: 'XAU/USD (Vàng Forex)',
      currentPrice: Number(currentPrice.toFixed(2)),
      timeframe,
      nwe,
      activeDemand,
      activeSupply,
      keyLevels,
      touchingDemand,
      touchingSupply,
      signal,
      signalReason,
      sweepSignal,
      alertTier,
      updatedAt: new Date(),
    };

    this.analysisCache.set(cacheKey, { result, time: now });
    return result;
  }

  /**
   * LẤY CẤU HÌNH NGƯỜI DÙNG CHO CẢNH BÁO NWE & SMC (Có in-memory fallback chuẩn xác)
   */
  async getUserSettings(chatId: string): Promise<UserSmcSettings> {
    if (this.userSettingsFallback.has(chatId)) {
      return this.userSettingsFallback.get(chatId)!;
    }

    try {
      const user = await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.findUnique({
          where: { chatId },
          select: {
            nweAlertEnabled: true,
            smcAlertEnabled: true,
            smcTimeframes: true,
          },
        }),
      );

      if (user) {
        const settings: UserSmcSettings = {
          nweAlertEnabled: user.nweAlertEnabled ?? true,
          smcAlertEnabled: user.smcAlertEnabled ?? true,
          timeframes: (user.smcTimeframes as SmcTimeframe[]) || ['M5', 'M15', 'H1', 'H4'],
        };
        this.userSettingsFallback.set(chatId, settings);
        return settings;
      }
    } catch (e: any) {
      // Bỏ qua lỗi DB schema nếu chưa migrate cột mới
    }

    const defaultSettings: UserSmcSettings = {
      nweAlertEnabled: true,
      smcAlertEnabled: true,
      timeframes: ['M5', 'M15', 'H1', 'H4'],
    };
    this.userSettingsFallback.set(chatId, defaultSettings);
    return defaultSettings;
  }

  /**
   * Bật/Tắt Cảnh báo Nadaraya-Watson Envelope (NWE)
   */
  async toggleNwe(chatId: string): Promise<UserSmcSettings> {
    const current = await this.getUserSettings(chatId);
    current.nweAlertEnabled = !current.nweAlertEnabled;
    this.userSettingsFallback.set(chatId, current);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.update({
          where: { chatId },
          data: { nweAlertEnabled: current.nweAlertEnabled },
        }),
      );
    } catch (e) {}

    return current;
  }

  /**
   * Bật/Tắt Cảnh báo Supply/Demand & Order Block (SMC)
   */
  async toggleSmc(chatId: string): Promise<UserSmcSettings> {
    const current = await this.getUserSettings(chatId);
    current.smcAlertEnabled = !current.smcAlertEnabled;
    this.userSettingsFallback.set(chatId, current);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.update({
          where: { chatId },
          data: { smcAlertEnabled: current.smcAlertEnabled },
        }),
      );
    } catch (e) {}

    return current;
  }

  /**
   * Bật/Tắt từng khung thời gian riêng biệt (M5, M15, M30, H1, H4, D1)
   */
  async toggleTimeframe(chatId: string, tf: SmcTimeframe): Promise<UserSmcSettings> {
    const current = await this.getUserSettings(chatId);
    if (current.timeframes.includes(tf)) {
      current.timeframes = current.timeframes.filter((t) => t !== tf);
    } else {
      current.timeframes.push(tf);
    }
    this.userSettingsFallback.set(chatId, current);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.update({
          where: { chatId },
          data: { smcTimeframes: current.timeframes },
        }),
      );
    } catch (e) {}

    return current;
  }

  /**
   * Bật tất cả các khung thời gian
   */
  async setAllTimeframes(chatId: string): Promise<UserSmcSettings> {
    const current = await this.getUserSettings(chatId);
    current.timeframes = [...this.supportedTimeframes];
    this.userSettingsFallback.set(chatId, current);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.update({
          where: { chatId },
          data: { smcTimeframes: current.timeframes },
        }),
      );
    } catch (e) {}

    return current;
  }

  /**
   * Đặt lại khung thời gian khuyên dùng (M5, M15, H1, H4)
   */
  async setDefaultTimeframes(chatId: string): Promise<UserSmcSettings> {
    const current = await this.getUserSettings(chatId);
    current.timeframes = ['M5', 'M15', 'H1', 'H4'];
    this.userSettingsFallback.set(chatId, current);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.update({
          where: { chatId },
          data: { smcTimeframes: current.timeframes },
        }),
      );
    } catch (e) {}

    return current;
  }

  /**
   * Lấy danh sách tất cả người dùng đăng ký nhận tin
   */
  async getAllSubscribers(): Promise<{ chatId: string; settings: UserSmcSettings }[]> {
    const result: { chatId: string; settings: UserSmcSettings }[] = [];

    // Nạp từ database
    try {
      const users = await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.findMany({
          select: {
            chatId: true,
            nweAlertEnabled: true,
            smcAlertEnabled: true,
            smcTimeframes: true,
          },
        }),
      );

      for (const u of users) {
        const settings: UserSmcSettings = {
          nweAlertEnabled: u.nweAlertEnabled ?? true,
          smcAlertEnabled: u.smcAlertEnabled ?? true,
          timeframes: (u.smcTimeframes as SmcTimeframe[]) || ['M5', 'M15', 'H1', 'H4'],
        };
        result.push({ chatId: u.chatId, settings });
      }
    } catch (e) {}

    // Ghép với activeChatIds fallback
    for (const chatId of this.activeChatIds) {
      if (!result.some((r) => r.chatId === chatId)) {
        const settings = await this.getUserSettings(chatId);
        result.push({ chatId, settings });
      }
    }

    return result;
  }

  /**
   * VÒNG LẶP QUÉT TỰ ĐỘNG KIỂM TRA CẢNH BÁO NWE & SMC TRÊN TẤT CẢ CÁC KHUNG THỜI GIAN
   */
  async checkAllSmcAlerts(): Promise<number> {
    let triggeredCount = 0;
    const now = Date.now();

    for (const tf of this.supportedTimeframes) {
      try {
        const analysis = await this.analyzeTimeframe(tf);
        if (analysis.signal === 'NORMAL') {
          // Reset state nếu giá đã rời khỏi vùng
          if (this.tfAlertStateMap.has(tf)) {
            const st = this.tfAlertStateMap.get(tf)!;
            if (st.lastSignal !== 'NORMAL' && now - st.lastAlertTime > 180 * 1000) {
              st.lastSignal = 'NORMAL';
            }
          }
          continue;
        }

        const stateKey = tf;
        const state = this.tfAlertStateMap.get(stateKey) || {
          lastSignal: 'NORMAL',
          lastAlertTime: 0,
          lastPrice: 0,
        };

        const isNewSignal = state.lastSignal !== analysis.signal;
        const isCooldownPassed = now - state.lastAlertTime > 150 * 1000; // Cooldown 2.5 phút

        if (isNewSignal || isCooldownPassed) {
          state.lastSignal = analysis.signal;
          state.lastAlertTime = now;
          state.lastPrice = analysis.currentPrice;
          this.tfAlertStateMap.set(stateKey, state);

          // Phát cảnh báo tới người dùng
          const subscribers = await this.getAllSubscribers();
          const isNweSignal =
            analysis.signal === 'TOUCH_NWE_UPPER' ||
            analysis.signal === 'TOUCH_NWE_LOWER' ||
            analysis.signal === 'CONFLUENCE_BUY' ||
            analysis.signal === 'CONFLUENCE_SELL';

          const isObSignal =
            analysis.signal === 'TOUCH_DEMAND_OB' ||
            analysis.signal === 'TOUCH_SUPPLY_OB' ||
            analysis.signal === 'CONFLUENCE_BUY' ||
            analysis.signal === 'CONFLUENCE_SELL';

          const alertMsg = this.renderAlertMessage(analysis);

          let sentCount = 0;
          for (const sub of subscribers) {
            // Kiểm tra user có bật khung thời gian này không
            if (!sub.settings.timeframes.includes(tf)) continue;

            // Kiểm tra user có bật loại cảnh báo tương ứng không
            const matchNwe = isNweSignal && sub.settings.nweAlertEnabled;
            const matchOb = isObSignal && sub.settings.smcAlertEnabled;

            if (matchNwe || matchOb) {
              try {
                await this.telegramService.sendMessage(sub.chatId, alertMsg, {
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: `📊 Xem SMC ${tf}`, callback_data: `smc_view:${tf}` },
                        { text: '⚙️ Cài đặt Bật/Tắt', callback_data: 'smc_open_settings' },
                      ],
                    ],
                  },
                });
                sentCount++;
              } catch (e) {}
            }
          }

          if (sentCount > 0) {
            triggeredCount++;
            if (analysis.alertTier === 2 && analysis.sweepSignal?.pool?.id) {
              this.liquiditySweepService.markPoolAsSwept(analysis.sweepSignal.pool.id);
            }
            this.logger.log(
              `🔔 [SMC/NWE ALERT ${analysis.alertTier === 2 ? 'TIER 2 (SWEEP)' : 'TIER 1'}] Khung ${tf}: ${analysis.signal} tại $${analysis.currentPrice} -> Đã gửi ${sentCount} user.`,
            );

            // Ghi log vào DB
            try {
              await this.prisma.executeWithRetry(() =>
                this.prisma.smcAlertLog.create({
                  data: {
                    symbol: 'XAU',
                    timeframe: tf,
                    alertType: analysis.signal,
                    price: analysis.currentPrice,
                    zoneTop: analysis.touchingSupply?.top || analysis.touchingDemand?.top,
                    zoneBottom: analysis.touchingSupply?.bottom || analysis.touchingDemand?.bottom,
                    message: analysis.signalReason,
                  },
                }),
              );
            } catch (e) {}
          }
        }
      } catch (err: any) {
        this.logger.debug(`Lỗi quét SMC khung ${tf}: ${err.message}`);
      }
    }

    return triggeredCount;
  }

  /**
   * FORMAT TIN NHẮN BẢO CÁO DASHBOARD XEM SMC & NWE
   */
  renderDashboard(analysis: SmcAnalysisResult): string {
    const nowStr = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date());

    let msg = `🌊 <b>NADARAYA-WATSON ENVELOPE & SMC (ORDER BLOCKS)</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💎 <b>Tài sản:</b> <code>${analysis.displaySymbol}</code>\n`;
    msg += `⏳ <b>Khung thời gian:</b> <b>${this.timeframeLabels[analysis.timeframe] || analysis.timeframe}</b>\n`;
    msg += `💰 <b>Giá hiện tại:</b> <code>$${analysis.currentPrice.toFixed(2)}</code>\n`;
    msg += `🕒 <i>Cập nhật: ${nowStr}</i>\n\n`;

    // 1. Chỉ số Nadaraya-Watson Envelope
    const nwe = analysis.nwe;
    msg += `📈 <b>NADARAYA-WATSON ENVELOPE (h=8, mult=3):</b>\n`;
    msg += `• 🔴 Dải trên (Upper Band): <code>$${nwe.upperBand.toFixed(2)}</code>\n`;
    msg += `• ⚪ Đường Kernel trung tâm: <code>$${nwe.kernel.toFixed(2)}</code>\n`;
    msg += `• 🟢 Dải dưới (Lower Band): <code>$${nwe.lowerBand.toFixed(2)}</code>\n`;
    msg += `• 🛡 Kháng cự động: <code>$${nwe.dynamicResistance.toFixed(2)}</code> | Hỗ trợ động: <code>$${nwe.dynamicSupport.toFixed(2)}</code>\n\n`;

    // 2. Vùng Supply & Demand (Order Blocks)
    msg += `📦 <b>CÁC VÙNG CUNG - CẦU (ORDER BLOCKS) GẦN NHẤT:</b>\n`;
    if (analysis.activeSupply.length > 0) {
      msg += `🔴 <b>Vùng Cung (Supply Zones / Bearish OB):</b>\n`;
      analysis.activeSupply.forEach((s) => {
        const dist = s.bottom - analysis.currentPrice;
        const distText = dist > 0 ? `(Cách +$${dist.toFixed(2)})` : `(ĐANG TRONG VÙNG)`;
        msg += `  • <code>$${s.bottom.toFixed(2)} - $${s.top.toFixed(2)}</code> ${distText}\n`;
      });
    } else {
      msg += `🔴 <b>Vùng Cung (Supply):</b> <i>Không có vùng cản gần</i>\n`;
    }

    if (analysis.activeDemand.length > 0) {
      msg += `🟢 <b>Vùng Cầu (Demand Zones / Bullish OB):</b>\n`;
      analysis.activeDemand.forEach((d) => {
        const dist = analysis.currentPrice - d.top;
        const distText = dist > 0 ? `(Cách -$${dist.toFixed(2)})` : `(ĐANG TRONG VÙNG)`;
        msg += `  • <code>$${d.bottom.toFixed(2)} - $${d.top.toFixed(2)}</code> ${distText}\n`;
      });
    } else {
      msg += `🟢 <b>Vùng Cầu (Demand):</b> <i>Không có vùng đỡ gần</i>\n`;
    }
    msg += `\n`;

    // 3. Trạng thái hiện tại
    msg += `⚡ <b>Trạng thái:</b> <b>${analysis.signalReason}</b>\n`;
    if (analysis.alertTier === 2 && analysis.sweepSignal?.pool) {
      const sweep = analysis.sweepSignal;
      const poolLabel = sweep.type === 'SELL_SWEEP' ? 'Quét Đỉnh (BSL)' : 'Quét Đáy (SSL)';
      msg += `🔥 <b>Tín hiệu nâng cao:</b> <b>[TIER 2] CÓ QUÉT THANH KHOẢN (${poolLabel}) tại $${sweep.pool.price} (SL: $${sweep.suggestedSL})</b>\n`;
    }

    return msg;
  }

  /**
   * FORMAT TIN NHẮN CẢNH BÁO GỬI TELEGRAM KHI CHẠM NWE HOẶC ORDER BLOCK
   */
  renderAlertMessage(analysis: SmcAnalysisResult): string {
    const nowStr = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date());

    const isSell =
      analysis.signal === 'CONFLUENCE_SELL' ||
      analysis.signal === 'TOUCH_SUPPLY_OB' ||
      analysis.signal === 'TOUCH_NWE_UPPER';
    const isTier2 =
      analysis.alertTier === 2 && analysis.sweepSignal?.hasSweep && !!analysis.sweepSignal.pool;
    const sweep = analysis.sweepSignal;

    let headerEmoji = '🔔';
    let headerTitle = 'CẢNH BÁO KỸ THUẬT: KHỚP VÙNG QUAN TRỌNG!';
    let adviceText = '';

    let sweepBlock = '';
    if (isTier2 && sweep?.pool) {
      headerEmoji = '🔥🔥 ' + (isSell ? '🔴🔴' : '🟢🟢');
      headerTitle = '[TIER 2 - HIGH PROBABILITY] QUÉT THANH KHOẢN + NADARAYA-WATSON & SMC ORDER BLOCKS';

      const poolTypeLabel =
        sweep.type === 'SELL_SWEEP'
          ? 'Quét Đỉnh (BSL Sweep -> Canh SELL)'
          : 'Quét Đáy (SSL Sweep -> Canh BUY)';
      const majorTag = sweep.pool.isMajorPool ? ' ⭐ [EQH/EQL Bể lớn]' : '';
      const wickPct = ((sweep.wickRatio || 0) * 100).toFixed(1);

      sweepBlock += `🌊 <b>TÍN HIỆU QUÉT THANH KHOẢN THẬT (TRUE LIQUIDITY SWEEP):</b>\n`;
      sweepBlock += `• 🎯 <b>Loại quét:</b> <b>${poolTypeLabel}</b>\n`;
      sweepBlock += `• 📍 <b>Mốc bị quét:</b> <code>$${sweep.pool.price.toFixed(2)}</code> <i>(hình thành lúc ${sweep.pool.timeStr} khung M15)</i>${majorTag}\n`;
      sweepBlock += `• 📏 <b>Độ sâu quét:</b> <code>$${sweep.sweepDepth?.toFixed(2)}</code> (${sweep.sweepDepthAtrRatio} ATR) - Râu nến rút: <b>${wickPct}%</b>\n`;
      sweepBlock += `• 🛑 <b>Gợi ý SL tối ưu sau râu quét:</b> <code>$${sweep.suggestedSL?.toFixed(2)}</code>\n\n`;
    }

    if (analysis.signal === 'CONFLUENCE_SELL') {
      if (!isTier2) {
        headerEmoji = '🚨🔴🔴';
        headerTitle = 'HỢP LƯU BÁN CỰC MẠNH: DẢI TRÊN NWE + VÙNG CUNG (SUPPLY OB)!';
      }
      adviceText =
        '💡 <b>Khuyến nghị chiến lược:</b>\n' +
        '• Giá chạm đồng thời 2 lớp cản: Biên trên Nadaraya-Watson Envelope và khối Bearish Order Block.\n' +
        '• Áp lực bán chặn chiều tăng cực lớn. Thích hợp mở vị thế <b>SELL / SHORT</b> hoặc chốt lời vị thế BUY!';
    } else if (analysis.signal === 'CONFLUENCE_BUY') {
      if (!isTier2) {
        headerEmoji = '🚨🟢🟢';
        headerTitle = 'HỢP LƯU MUA CỰC MẠNH: DẢI DƯỚI NWE + VÙNG CẦU (DEMAND OB)!';
      }
      adviceText =
        '💡 <b>Khuyến nghị chiến lược:</b>\n' +
        '• Giá chạm đồng thời 2 lớp đỡ: Biên dưới Nadaraya-Watson Envelope và khối Bullish Order Block.\n' +
        '• Lực cầu bắt đáy nhập cuộc mạnh. Thích hợp mở vị thế <b>BUY / LONG</b> bắt sóng hồi phục!';
    } else if (analysis.signal === 'TOUCH_SUPPLY_OB') {
      if (!isTier2) {
        headerEmoji = '🧱🔴';
        headerTitle = 'GIÁ ĐÃ CHẠM VÙNG CUNG (SUPPLY ZONE / BEARISH ORDER BLOCK)!';
      }
      adviceText =
        '💡 <b>Khuyến nghị chiến lược:</b>\n' +
        '• Giá đã tiến vào vùng tồn đọng lệnh bán của cá mập (Bearish OB). Canh phản ứng từ chối giá (rút râu nến) để vào lệnh <b>SELL</b>.';
    } else if (analysis.signal === 'TOUCH_DEMAND_OB') {
      if (!isTier2) {
        headerEmoji = '🧱🟢';
        headerTitle = 'GIÁ ĐÃ CHẠM VÙNG CẦU (DEMAND ZONE / BULLISH ORDER BLOCK)!';
      }
      adviceText =
        '💡 <b>Khuyến nghị chiến lược:</b>\n' +
        '• Giá đã rơi vào vùng thanh khoản mua của tổ chức (Bullish OB). Canh phản ứng đảo chiều rút chân để vào lệnh <b>BUY</b>.';
    } else if (analysis.signal === 'TOUCH_NWE_UPPER') {
      if (!isTier2) {
        headerEmoji = '🌊🔴';
        headerTitle = 'GIÁ CHẠM DẢI TRÊN NADARAYA-WATSON ENVELOPE (QUÁ MUA)!';
      }
      adviceText =
        '💡 <b>Khuyến nghị chiến lược:</b>\n' +
        '• Biên độ giá bung vượt khỏi dải biên trên NWE (Quá Mua kỹ thuật). Xác suất điều chỉnh ngắn hạn rất cao.';
    } else if (analysis.signal === 'TOUCH_NWE_LOWER') {
      if (!isTier2) {
        headerEmoji = '🌊🟢';
        headerTitle = 'GIÁ CHẠM DẢI DƯỚI NADARAYA-WATSON ENVELOPE (QUÁ BÁN)!';
      }
      adviceText =
        '💡 <b>Khuyến nghị chiến lược:</b>\n' +
        '• Biên độ giá xuyên thủng dải biên dưới NWE (Quá Bán kỹ thuật). Thích hợp quan sát nhịp hồi phục kỹ thuật.';
    }

    if (isTier2) {
      adviceText =
        '💡 <b>Khuyến nghị chiến lược [TIER 2 - SUPER CONFLUENCE]:</b>\n' +
        '• Đỉnh cao hợp lưu: Giá chạm vùng quan trọng (NWE / Order Block) ĐỒNG THỜI vừa quét sạch bể thanh khoản (Liquidity Sweep) và rút râu đảo chiều mạnh!\n' +
        `• Tỷ lệ thắng (Winrate) cực cao. Thích hợp mở vị thế <b>${isSell ? 'SELL / SHORT' : 'BUY / LONG'}</b> với SL ngay sau râu nến quét!`;
    }

    let msg = `${headerEmoji} <b>${headerTitle}</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    if (sweepBlock) {
      msg += `${sweepBlock}`;
    }
    msg += `💎 <b>Tài sản:</b> <code>${analysis.displaySymbol}</code>\n`;
    msg += `⏳ <b>Khung thời gian:</b> <b>${this.timeframeLabels[analysis.timeframe] || analysis.timeframe}</b>\n`;
    msg += `💵 <b>Giá thị trường hiện tại:</b> <code>$${analysis.currentPrice.toFixed(2)}</code>\n\n`;

    msg += `⚡ <b>Hiện tượng phát hiện:</b>\n`;
    msg += `• ${analysis.signalReason}\n\n`;

    msg += `📊 <b>THÔNG SỐ VÙNG KỸ THUẬT:</b>\n`;
    msg += `• NWE Upper: <code>$${analysis.nwe.upperBand.toFixed(2)}</code> | Lower: <code>$${analysis.nwe.lowerBand.toFixed(2)}</code>\n`;
    msg += `• Kháng cự động: <code>$${analysis.nwe.dynamicResistance.toFixed(2)}</code> | Hỗ trợ động: <code>$${analysis.nwe.dynamicSupport.toFixed(2)}</code>\n`;
    if (analysis.touchingSupply) {
      msg += `• 🔴 Biên độ Vùng Cung: <code>$${analysis.touchingSupply.bottom.toFixed(2)} - $${analysis.touchingSupply.top.toFixed(2)}</code>\n`;
    }
    if (analysis.touchingDemand) {
      msg += `• 🟢 Biên độ Vùng Cầu: <code>$${analysis.touchingDemand.bottom.toFixed(2)} - $${analysis.touchingDemand.top.toFixed(2)}</code>\n`;
    }
    msg += `⏱ <b>Thời gian:</b> <code>${nowStr}</code>\n\n`;

    msg += `${adviceText}`;

    return msg;
  }
}
