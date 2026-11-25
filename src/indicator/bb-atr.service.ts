import { Injectable, Logger, Inject, Optional, forwardRef, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { EmaTimeframe } from './indicator.interface';
import {
  CandleData,
  BollingerBandsResult,
  BbAtrSignalType,
  BbAtrBias,
  BbAtrState,
  BbAtrAlertItem,
  CreateBbAtrAlertDto,
  CreateBbAtrAlertResult,
  ActiveBbAtrAlertDetail,
} from './bb-atr.interface';
import {
  classifySignalTier,
  normalizeCandleTimeMs,
  M5_DURATION_MS,
} from './signal-classifier';
import { SuperTierService } from '../common/super-tier.service';
import { SubscriberCacheService } from '../common/subscriber-cache.service';

@Injectable()
export class BbAtrService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BbAtrService.name);

  // TradingView Real-time WebSocket Live Feed (0ms delay)
  private liveWs: any = null;
  private liveCandles: CandleData[] = [];
  private livePrice = 0;
  private liveCandleTime = 0;
  private isWsConnected = false;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private wsWatchdogTimer: NodeJS.Timeout | null = null;
  private lastWsMessageAt = 0;
  private wsConnectingSince = 0;
  private isWsConnecting = false;
  private isDestroyed = false;
  private readonly WS_WATCHDOG_TICK_MS = 5_000;
  private readonly WS_PING_INTERVAL_MS = Math.max(5_000, Number(process.env.WS_PING_INTERVAL_MS) || 15_000);
  private readonly WS_STALE_TIMEOUT_MS = Math.max(15_000, Number(process.env.WS_STALE_TIMEOUT_MS) || 35_000);
  private readonly WS_CLOCK_JUMP_THRESHOLD_MS = 30_000;
  private readonly WS_RECONNECT_BASE_DELAY_MS = 1_000;
  private readonly WS_RECONNECT_MAX_DELAY_MS = 30_000;
  private lastWatchdogTickAt = 0;
  private lastWsPingAt = 0;
  private wsReconnectAttempt = 0;
  private wsHasEverOpened = false;
  private wsNeedsPostReconnectScan = false;
  private wsReconnectAt = 0;

  // Quản lý cảnh báo theo từng nến M5 (Khắc phục lỗi chỉ alert 1 lần khi nhiều nến liên tiếp chạm)
  private lastAlertCandleTime = 0;
  private lastCandleAlertLevel: BbAtrSignalType = 'NORMAL';
  private consecutiveTouchCount = 0;

  // Cache nến klines ngắn hạn (6 giây) để tiết kiệm băng thông và tối ưu hiệu năng
  private readonly candlesCache = new Map<string, { candles: CandleData[]; price: number; time: number }>();

  // Danh sách alias cho Vàng
  private readonly goldAliases = new Set([
    'XAU',
    'GOLD',
    'XAUUSD',
    'VANG',
    'VANGTHEGIOI',
    'XAU/USD',
  ]);

  readonly supportedTimeframes: EmaTimeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

  readonly binanceIntervalMap: Record<EmaTimeframe, string> = {
    M1: '1m',
    M5: '5m',
    M15: '15m',
    M30: '30m',
    H1: '1h',
    H4: '4h',
    D1: '1d',
  };

  readonly tradingViewTfMap: Record<EmaTimeframe, string> = {
    M1: '1',
    M5: '5',
    M15: '15',
    M30: '30',
    H1: '60',
    H4: '240',
    D1: '',
  };

  // Cache dữ liệu TradingView Scanner ngắn hạn (4 giây)
  private readonly tvGoldCache = new Map<string, { data: any; time: number }>();

  readonly timeframeLabels: Record<EmaTimeframe, string> = {
    M1: '1 Phút (M1)',
    M5: '5 Phút (M5)',
    M15: '15 Phút (M15)',
    M30: '30 Phút (M30)',
    H1: '1 Giờ (H1)',
    H4: '4 Giờ (H4)',
    D1: '1 Ngày (D1)',
  };

  readonly timeframeDurationMsMap: Record<EmaTimeframe, number> = {
    M1: 60 * 1000,
    M5: 5 * 60 * 1000,
    M15: 15 * 60 * 1000,
    M30: 30 * 60 * 1000,
    H1: 60 * 60 * 1000,
    H4: 4 * 60 * 60 * 1000,
    D1: 24 * 60 * 60 * 1000,
  };

  // Quản lý trạng thái Global Auto-Scanner cho XAU/USD M5 để chống spam tin nhắn
  private lastGlobalSignal: BbAtrSignalType = 'NORMAL';
  private lastGlobalAlertTime = 0;
  private lastGlobalAlertPrice = 0;
  private lastAlertTier = 0;
  private scanTickCount = 0;

  // Mutex/lock chống Race Condition giữa TradingView WebSocket callback và Cron 3s
  private isCheckingGlobalXau = false;

  // Chống bắn trùng cho tín hiệu nến rút râu M5 (vẫn cho phép upgrade Tier 2B -> Tier 3 trên cùng 1 nến)
  private lastWickAlertCandleTime = 0;
  private lastWickAlertTier = 0;

  // Cache cấu hình người dùng phòng trường hợp DB chưa migrate cột mới
  private readonly userSettingFallback = new Map<string, boolean>();
  private readonly userTier0Fallback = new Map<string, boolean>();
  private readonly userTier2Fallback = new Map<string, boolean>();
  private readonly userBiasFallback = new Map<string, BbAtrBias>();
  private readonly activeChatIds = new Set<string>(['5513976350']);

  /**
   * Đăng ký chatId đang hoạt động để đảm bảo luôn nhận được alert ngay cả khi DB nghẽn pool
   */
  registerActiveChat(chatId: string) {
    if (chatId) {
      this.activeChatIds.add(chatId);
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TelegramService))
    private readonly telegramService: TelegramService,
    @Optional()
    private readonly superTierService?: SuperTierService,
    @Optional()
    private readonly subscriberCache?: SubscriberCacheService,
  ) {}

  onModuleInit() {
    this.isDestroyed = false;
    this.initTradingViewLiveStream();
    this.startWsWatchdog();
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    this.stopTradingViewLiveStream();
  }

  /**
   * Kiểm tra luồng WebSocket có thực sự còn sống và đang nhận dữ liệu mới hay không
   * (Chống lỗi Zombie/Half-Open TCP Socket khi máy Mac sleep hoặc đổi Wi-Fi)
   */
  private isLiveWsFresh(): boolean {
    return (
      this.isWsConnected &&
      this.liveWs?.readyState === 1 &&
      this.lastWsMessageAt > 0 &&
      Date.now() - this.lastWsMessageAt < this.WS_STALE_TIMEOUT_MS
    );
  }

  private startWsWatchdog() {
    if (this.wsWatchdogTimer) return;
    this.lastWatchdogTickAt = Date.now();
    this.wsWatchdogTimer = setInterval(() => {
      if (this.isDestroyed) return;
      const now = Date.now();
      const tickDelta = this.lastWatchdogTickAt > 0 ? now - this.lastWatchdogTickAt : 0;
      this.lastWatchdogTickAt = now;

      if (tickDelta > this.WS_CLOCK_JUMP_THRESHOLD_MS && (this.liveWs || this.isWsConnecting)) {
        this.forceReconnectLiveWs(`phát hiện clock jump/sleep (${Math.round(tickDelta / 1000)}s)`);
        return;
      }

      if (this.liveWs) {
        const isOpen = this.liveWs.readyState === 1;
        const idleMs = this.lastWsMessageAt > 0 ? now - this.lastWsMessageAt : 0;

        if (this.isWsConnecting && this.wsConnectingSince > 0 && now - this.wsConnectingSince >= 20_000) {
          this.forceReconnectLiveWs('treo ở trạng thái kết nối (handshake > 20s)');
          return;
        }

        if (!isOpen && !this.isWsConnecting) {
          this.forceReconnectLiveWs('socket không ở trạng thái OPEN');
          return;
        }

        if (this.isWsConnected && this.lastWsMessageAt > 0 && idleMs >= this.WS_STALE_TIMEOUT_MS) {
          this.forceReconnectLiveWs(`không nhận dữ liệu/heartbeat suốt ${Math.round(idleMs / 1000)}s (zombie socket)`);
          return;
        }

        if (isOpen && now - this.lastWsPingAt >= this.WS_PING_INTERVAL_MS) {
          this.lastWsPingAt = now;
          try {
            this.liveWs.ping();
          } catch (e) {
            this.forceReconnectLiveWs('gửi WebSocket ping thất bại');
          }
        }
      } else if (!this.isWsConnecting && !this.wsReconnectTimer) {
        this.initTradingViewLiveStream();
      }
    }, this.WS_WATCHDOG_TICK_MS);
  }

  private computeWsReconnectDelayMs(): number {
    const exp = Math.min(
      this.WS_RECONNECT_MAX_DELAY_MS,
      this.WS_RECONNECT_BASE_DELAY_MS * Math.pow(2, this.wsReconnectAttempt),
    );
    const jitter = Math.floor(Math.random() * 500);
    return exp + jitter;
  }

  private forceReconnectLiveWs(reason: string) {
    if (this.isDestroyed) return;
    this.logger.warn(`⚠️ [Live WebSocket] Phát hiện kết nối treo (${reason}). Đang ép ngắt và kết nối lại...`);

    const staleWs = this.liveWs;
    this.liveWs = null;
    this.isWsConnected = false;
    this.isWsConnecting = false;
    this.wsConnectingSince = 0;
    this.lastWsMessageAt = 0;
    this.lastWsPingAt = 0;
    if (this.wsReconnectAt === 0) {
      this.wsReconnectAt = Date.now();
    }

    if (staleWs) {
      try {
        if (typeof staleWs.terminate === 'function') {
          staleWs.terminate();
        } else {
          staleWs.close();
        }
      } catch (e) {}
    }

    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }

    this.scheduleWsReconnect();
  }

  /**
   * Khởi chạy luồng WebSocket thời gian thực kết nối trực tiếp TradingView OANDA:XAUUSD
   * Cập nhật từng tick theo mili-giây (0ms delay), loại bỏ hoàn toàn độ trễ 1-2 phút của Scanner
   */
  private initTradingViewLiveStream() {
    if (this.isDestroyed || this.isWsConnecting || this.isWsConnected) return;
    this.isWsConnecting = true;
    this.wsConnectingSince = Date.now();

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const WebSocket = require('ws');
      const ws = new WebSocket('wss://data.tradingview.com/socket.io/websocket', {
        headers: {
          Origin: 'https://www.tradingview.com',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
        handshakeTimeout: 10_000,
      });
      this.liveWs = ws;

      const createMsg = (func: string, args: any[]) => {
        const json = JSON.stringify({ m: func, p: args });
        return '~m~' + json.length + '~m~' + json;
      };

      const chartSession = 'cs_' + Math.random().toString(36).substring(2, 12);

      ws.on('open', () => {
        if (this.liveWs !== ws) return;
        this.logger.log('🟢 [Live WebSocket] Đã kết nối luồng giá thời gian thực TradingView OANDA:XAUUSD (0ms latency)!');
        this.isWsConnected = true;
        this.isWsConnecting = false;
        const openNow = Date.now();
        this.lastWsMessageAt = openNow;
        this.lastWsPingAt = openNow;
        if (this.wsHasEverOpened) {
          this.wsNeedsPostReconnectScan = true;
        }
        this.wsHasEverOpened = true;
        // Reset mảng nến cũ để tránh trộn dữ liệu đóng băng trước khi reconnect
        this.liveCandles = [];

        ws.send(createMsg('set_auth_token', ['unauthorized_user_token']));
        ws.send(createMsg('chart_create_session', [chartSession, '']));
        ws.send(
          createMsg('resolve_symbol', [chartSession, 'sds_sym_1', '={"symbol":"OANDA:XAUUSD","adjustment":"splits"}']),
        );
        ws.send(createMsg('create_series', [chartSession, 'sds_1', 's1', 'sds_sym_1', '5', 150, '']));
      });

      ws.on('pong', () => {
        if (this.liveWs !== ws) return;
        this.lastWsMessageAt = Date.now();
      });

      ws.on('message', (data: any) => {
        if (this.liveWs !== ws) return;
        this.lastWsMessageAt = Date.now();

        const raw = data.toString();
        const packets = raw.split(/~m~\d+~m~/).filter(Boolean);
        for (const packet of packets) {
          if (packet.startsWith('~h~')) {
            if (ws.readyState === 1) {
              ws.send('~m~' + packet.length + '~m~' + packet);
            }
            continue;
          }
          try {
            const msg = JSON.parse(packet);
            if (msg.m === 'timescale_update' || msg.m === 'du') {
              const sds = msg.p[1]?.sds_1;
              if (sds && sds.s && Array.isArray(sds.s) && sds.s.length > 0) {
                this.wsReconnectAttempt = 0;
                this.handleLiveCandlesUpdate(sds.s);
                if (msg.m === 'timescale_update' && this.wsNeedsPostReconnectScan && this.liveCandles.length >= 20) {
                  this.wsNeedsPostReconnectScan = false;
                  const elapsedMs = this.wsReconnectAt > 0 ? Date.now() - this.wsReconnectAt : 0;
                  this.wsReconnectAt = 0;
                  this.logger.log(
                    `🔄 [Live WebSocket] Đã đồng bộ lại nến M5 sau reconnect${elapsedMs > 0 ? ` (${elapsedMs}ms)` : ''}. Đang quét tín hiệu ngay...`,
                  );
                  this.checkGlobalXauM5Alert().catch((err) => {
                    this.logger.warn(`Lỗi quét BB+ATR ngay sau WS reconnect: ${err.message}`);
                  });
                }
              }
            }
          } catch (e) {}
        }
      });

      ws.on('close', () => {
        if (this.liveWs !== ws) return;
        this.liveWs = null;
        this.isWsConnected = false;
        this.isWsConnecting = false;
        this.lastWsMessageAt = 0;
        this.scheduleWsReconnect();
      });

      ws.on('error', (err: any) => {
        if (this.liveWs !== ws) return;
        this.logger.warn(`⚠️ [Live WebSocket] Mất kết nối: ${err.message}. Đang thử kết nối lại...`);
        this.liveWs = null;
        this.isWsConnected = false;
        this.isWsConnecting = false;
        this.lastWsMessageAt = 0;
        try {
          ws.terminate?.();
        } catch (e) {}
        this.scheduleWsReconnect();
      });
    } catch (err: any) {
      this.logger.error(`Không thể kết nối WebSocket TradingView: ${err.message}`);
      this.isWsConnecting = false;
      this.scheduleWsReconnect();
    }
  }

  private scheduleWsReconnect() {
    if (this.isDestroyed || this.wsReconnectTimer) return;
    const delayMs = this.computeWsReconnectDelayMs();
    this.wsReconnectAttempt++;
    if (this.wsReconnectAt === 0) {
      this.wsReconnectAt = Date.now();
    }
    this.logger.warn(`🔄 [Live WebSocket] Lên lịch reconnect lần #${this.wsReconnectAttempt} sau ${delayMs}ms...`);
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      this.initTradingViewLiveStream();
    }, delayMs);
  }

  private stopTradingViewLiveStream() {
    if (this.wsWatchdogTimer) {
      clearInterval(this.wsWatchdogTimer);
      this.wsWatchdogTimer = null;
    }
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.liveWs) {
      try {
        if (typeof this.liveWs.terminate === 'function') {
          this.liveWs.terminate();
        } else {
          this.liveWs.close();
        }
      } catch (e) {}
      this.liveWs = null;
    }
    this.isWsConnected = false;
    this.isWsConnecting = false;
    this.wsConnectingSince = 0;
    this.lastWsMessageAt = 0;
    this.lastWatchdogTickAt = 0;
    this.lastWsPingAt = 0;
    this.wsNeedsPostReconnectScan = false;
  }

  private handleLiveCandlesUpdate(rows: any[]) {
    for (const row of rows) {
      if (!row || !Array.isArray(row.v) || row.v.length < 5) continue;
      const t = row.v[0] * 1000;
      const candle: CandleData = {
        time: t,
        open: Number(row.v[1]),
        high: Number(row.v[2]),
        low: Number(row.v[3]),
        close: Number(row.v[4]),
        volume: Number(row.v[5] || 0),
      };

      const idx = this.liveCandles.findIndex((c) => c.time === t);
      if (idx >= 0) {
        this.liveCandles[idx].high = Math.max(this.liveCandles[idx].high, candle.high);
        this.liveCandles[idx].low = Math.min(this.liveCandles[idx].low, candle.low);
        this.liveCandles[idx].close = candle.close;
      } else {
        this.liveCandles.push(candle);
        // Lưu trữ tối đa 200 nến để thuật toán Wilder's Smoothing của ATR và RSI hội tụ chuẩn 100%
        if (this.liveCandles.length > 200) {
          this.liveCandles.shift();
        }
      }
    }

    if (
      this.liveCandles.length > 1 &&
      this.liveCandles[this.liveCandles.length - 1].time < this.liveCandles[this.liveCandles.length - 2].time
    ) {
      this.liveCandles.sort((a, b) => a.time - b.time);
    }

    if (this.liveCandles.length > 0) {
      const last = this.liveCandles[this.liveCandles.length - 1];
      this.livePrice = last.close;
      this.liveCandleTime = last.time;

      if (this.liveCandles.length >= 20) {
        this.evaluateLiveTickSignal();
      }
    }
  }

  private evaluateLiveTickSignal() {
    try {
      const closes = this.liveCandles.map((c) => c.close);
      const bb = this.calculateBollingerBands(closes, 20, 2.0);
      const atr = this.calculateAtr(this.liveCandles, 14);
      const rsi = this.calculateRsi(closes, 14);

      const last = this.liveCandles[this.liveCandles.length - 1];
      const prevCandle = this.liveCandles.length >= 2 ? this.liveCandles[this.liveCandles.length - 2] : undefined;
      const now = Date.now();
      const candleTime = normalizeCandleTimeMs(last.time);

      let classified = classifySignalTier({
        price: last.close,
        high: last.high,
        low: last.low,
        bbUpper: bb.upper,
        bbLower: bb.lower,
        atr,
        rsi,
        candle: last,
        prevCandle,
        nowMs: now,
        candleDurationMs: M5_DURATION_MS,
      });

      const isWickSignal =
        classified.tierReason === 'TIER_2B_M5_WICK' || classified.tierReason === 'TIER_3_M5_WICK';
      if (
        isWickSignal &&
        classified.rejectionCandleTime !== undefined &&
        classified.rejectionCandleTime <= this.lastWickAlertCandleTime &&
        classified.alertTier <= this.lastWickAlertTier
      ) {
        if (classified.rejectionCandleTime < candleTime) {
          // Nến rút râu từ prevCandle đã được báo rồi -> đánh giá lại nến hiện tại không dùng prevCandle
          classified = classifySignalTier({
            price: last.close,
            high: last.high,
            low: last.low,
            bbUpper: bb.upper,
            bbLower: bb.lower,
            atr,
            rsi,
            nowMs: now,
            candleDurationMs: M5_DURATION_MS,
          });
        } else {
          return;
        }
      }

      // Kích hoạt bắn cảnh báo khi có tín hiệu chạm dải BB hoặc khớp Entry (+/- ATR) hoặc rút râu M5
      if (classified.signal !== 'NORMAL') {
        const isNewCandle = candleTime > this.lastAlertCandleTime;
        const isUpgradeSignal = classified.alertTier > (this.lastAlertTier || 0);
        const isCooldownPassed = now - this.lastGlobalAlertTime > 90 * 1000;

        if (isNewCandle || isUpgradeSignal || isCooldownPassed) {
          this.checkGlobalXauM5Alert().catch((err) => {
            this.logger.error(`Lỗi kích hoạt live tick alert: ${err.message}`);
          });
        }
      }
    } catch (e) {}
  }

  /**
   * Chuẩn hóa mã khung thời gian, mặc định là M5 theo chiến lược của người dùng
   */
  normalizeTimeframe(input?: string): EmaTimeframe {
    if (!input) return 'M5';
    const clean = input.trim().toUpperCase();

    if (this.supportedTimeframes.includes(clean as EmaTimeframe)) {
      return clean as EmaTimeframe;
    }

    const mapping: Record<string, EmaTimeframe> = {
      '1': 'M1',
      '1M': 'M1',
      'M1': 'M1',
      '5': 'M5',
      '5M': 'M5',
      'M5': 'M5',
      '15': 'M15',
      '15M': 'M15',
      'M15': 'M15',
      '30': 'M30',
      '30M': 'M30',
      'M30': 'M30',
      '60': 'H1',
      '60M': 'H1',
      '1H': 'H1',
      'H1': 'H1',
      '4H': 'H4',
      '240': 'H4',
      'H4': 'H4',
      '1D': 'D1',
      'D': 'D1',
      'D1': 'D1',
      'DAY': 'D1',
      'NGAY': 'D1',
    };

    return mapping[clean] || 'M5';
  }

  /**
   * Tính toán dải Bollinger Bands (20, 2)
   * Middle Band = SMA(20)
   * Upper Band = Middle + 2 * stdDev
   * Lower Band = Middle - 2 * stdDev
   */
  calculateBollingerBands(closes: number[], period = 20, multiplier = 2.0): BollingerBandsResult {
    if (!closes || closes.length < period) {
      throw new Error(`Cần tối thiểu ${period} nến để tính dải Bollinger Bands.`);
    }

    const slice = closes.slice(-period);
    const middle = slice.reduce((acc, val) => acc + val, 0) / period;

    const variance = slice.reduce((acc, val) => acc + Math.pow(val - middle, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    const upper = middle + multiplier * stdDev;
    const lower = middle - multiplier * stdDev;
    const bandwidth = middle > 0 ? (upper - lower) / middle : 0;

    const lastClose = closes[closes.length - 1];
    const range = upper - lower;
    const percentB = range > 0 ? (lastClose - lower) / range : 0.5;

    return {
      upper,
      middle,
      lower,
      bandwidth,
      percentB,
    };
  }

  /**
   * Tính chỉ số Average True Range (ATR 14) theo công thức Wilder's Smoothing (chuẩn MT4/MT5/TradingView)
   * TR = max(High - Low, |High - Close_prev|, |Low - Close_prev|)
   */
  calculateAtr(candles: CandleData[], period = 14): number {
    if (!candles || candles.length < period + 1) {
      throw new Error(`Cần tối thiểu ${period + 1} nến để tính chỉ số ATR(${period}).`);
    }

    const trValues: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (i === 0) {
        trValues.push(c.high - c.low);
      } else {
        const prevClose = candles[i - 1].close;
        const hl = c.high - c.low;
        const hpc = Math.abs(c.high - prevClose);
        const lpc = Math.abs(c.low - prevClose);
        trValues.push(Math.max(hl, hpc, lpc));
      }
    }

    // Giá trị ban đầu: SMA của `period` phần tử đầu
    let atr = trValues.slice(0, period).reduce((acc, val) => acc + val, 0) / period;

    // Wilder Smoothing cho các nến tiếp theo
    for (let i = period; i < trValues.length; i++) {
      atr = (atr * (period - 1) + trValues[i]) / period;
    }

    return Number(atr.toFixed(2));
  }

  /**
   * Tính chỉ số RSI(14) theo công thức chuẩn Wilder's Smoothing (đồng bộ 100% MT5 và TradingView)
   */
  calculateRsi(closes: number[], period = 14): number {
    if (!closes || closes.length < period + 1) {
      return 50;
    }

    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) {
        avgGain = (avgGain * (period - 1) + diff) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
      }
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return Number((100 - 100 / (1 + rs)).toFixed(2));
  }

  /**
   * Tải dữ liệu nến OHLC (Open, High, Low, Close, Volume)
   * Sử dụng Binance spot PAXGUSDT cho Vàng (tương đương 1 Ounce Vàng thế giới XAU/USD)
   */
  async fetchCandles(
    rawSymbol: string,
    timeframe: EmaTimeframe = 'M5',
    limit = 150,
  ): Promise<{ candles: CandleData[]; currentPrice: number; displaySymbol: string; assetType: 'GOLD' | 'CRYPTO' }> {
    const symbolUpper = rawSymbol.trim().toUpperCase().replace('/', '');
    const cacheKey = `${symbolUpper}:${timeframe}`;
    const now = Date.now();

    if (this.candlesCache.has(cacheKey)) {
      const cached = this.candlesCache.get(cacheKey)!;
      if (now - cached.time < 5000) {
        let assetType: 'GOLD' | 'CRYPTO' = 'CRYPTO';
        let displaySymbol = `${symbolUpper}/USDT`;
        if (this.goldAliases.has(symbolUpper)) {
          assetType = 'GOLD';
          displaySymbol = 'XAU/USD (Vàng)';
        }
        return {
          candles: cached.candles,
          currentPrice: cached.price,
          displaySymbol,
          assetType,
        };
      }
    }

    const interval = this.binanceIntervalMap[timeframe] || '5m';

    // 1. Dành cho VÀNG (XAU/USD)
    if (this.goldAliases.has(symbolUpper)) {
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
          const currentPrice = candles[candles.length - 1].close;
          this.candlesCache.set(cacheKey, { candles, price: currentPrice, time: now });
          return {
            candles,
            currentPrice,
            displaySymbol: 'XAU/USD (Vàng)',
            assetType: 'GOLD',
          };
        }
      } catch (err: any) {
        this.logger.error(`Lỗi tải nến Vàng: ${err.message}`);
        throw new Error(`Không thể lấy dữ liệu nến cho Vàng (XAU/USD): ${err.message}`);
      }
    }

    // 2. Dành cho CRYPTO
    const cryptoPair = symbolUpper.endsWith('USDT') ? symbolUpper : `${symbolUpper}USDT`;
    const cleanCrypto = symbolUpper.replace(/USDT$/, '');

    try {
      const res = await axios.get(
        `https://api.binance.com/api/v3/klines?symbol=${cryptoPair}&interval=${interval}&limit=${limit}`,
        { timeout: 5000 },
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
        const currentPrice = candles[candles.length - 1].close;
        this.candlesCache.set(cacheKey, { candles, price: currentPrice, time: now });
        return {
          candles,
          currentPrice,
          displaySymbol: `${cleanCrypto}/USDT`,
          assetType: 'CRYPTO',
        };
      }
    } catch (cryptoErr: any) {
      this.logger.debug(`Không tìm thấy crypto ${cryptoPair}: ${cryptoErr.message}`);
    }

    throw new Error(
      `Không tìm thấy dữ liệu cho mã <b>"${rawSymbol}"</b>.\n` +
      `💡 Hỗ trợ:\n` +
      `• Vàng: <code>XAU</code>, <code>GOLD</code>\n` +
      `• Crypto: <code>BTC</code>, <code>ETH</code>, <code>SOL</code>, <code>BNB</code>...`,
    );
  }

  /**
   * Tải dữ liệu kỹ thuật Vàng giao ngay (XAU/USD) trực tiếp từ TradingView Scanner (OANDA:XAUUSD / TVC:GOLD)
   * Giúp các mốc giá, Bollinger Bands và ATR đồng bộ chuẩn xác với sàn Forex/MT5 thay vì dùng PAXGUSDT
   */
  async fetchGoldFromTradingView(timeframe: EmaTimeframe): Promise<Partial<BbAtrState> | null> {
    const tf = this.tradingViewTfMap[timeframe] || '5';
    const isDaily = timeframe === 'D1';
    const suffix = isDaily ? '' : `|${tf}`;
    const cacheKey = `TV_GOLD:${timeframe}`;
    const now = Date.now();

    if (this.tvGoldCache.has(cacheKey)) {
      const cached = this.tvGoldCache.get(cacheKey)!;
      if (now - cached.time < 4000) {
        return cached.data;
      }
    }

    const columns = [
      'close',
      isDaily ? 'open' : `open${suffix}`,
      isDaily ? 'high' : `high${suffix}`,
      isDaily ? 'low' : `low${suffix}`,
      isDaily ? 'close' : `close${suffix}`,
      isDaily ? 'high' : `high[1]${suffix}`,
      isDaily ? 'low' : `low[1]${suffix}`,
      isDaily ? 'BB.upper' : `BB.upper${suffix}`,
      isDaily ? 'BB.lower' : `BB.lower${suffix}`,
      isDaily ? 'SMA20' : `SMA20${suffix}`,
      isDaily ? 'ATR' : `ATR${suffix}`,
    ];

    try {
      const res = await axios.post(
        'https://scanner.tradingview.com/cfd/scan',
        {
          symbols: {
            tickers: ['OANDA:XAUUSD', 'TVC:GOLD', 'FX_IDC:XAUUSD'],
          },
          columns,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          },
          timeout: 5000,
        },
      );

      if (res.data && Array.isArray(res.data.data) && res.data.data.length > 0) {
        const row = res.data.data.find((r: any) => r.d && r.d[0] > 0);
        if (row && Array.isArray(row.d) && row.d.length >= 11) {
          const d = row.d;
          const currentPrice = Number(d[0]) || 0;
          const currentHigh = Number(d[2]) || currentPrice;
          const currentLow = Number(d[3]) || currentPrice;
          const prevHigh = Number(d[5]) || currentHigh;
          const prevLow = Number(d[6]) || currentLow;

          // candleHigh là đỉnh cao nhất giữa nến hiện tại và nến trước đó vừa đóng
          const candleHigh = Math.max(currentHigh, prevHigh);
          const candleLow = Math.min(currentLow, prevLow);

          const bbUpper = Number(d[7]);
          const bbLower = Number(d[8]);
          const bbMiddle = Number(d[9]);
          const atrValue = Number(d[10]);

          if (currentPrice > 0 && bbUpper > 0 && bbLower > 0 && atrValue > 0) {
            const result: Partial<BbAtrState> = {
              currentPrice,
              candleHigh,
              candleLow,
              bbUpper,
              bbMiddle,
              bbLower,
              atrValue,
            };
            this.tvGoldCache.set(cacheKey, { data: result, time: now });
            return result;
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`TradingView Scanner fetch Vàng thất bại: ${err.message}. Đang dùng Binance fallback...`);
    }

    return null;
  }

  /**
   * Tính toán toàn diện trạng thái Chiến lược: Bollinger Bands(20) & ATR(14) trên khung M5
   * Công thức Entry:
   * - Upper Entry = Bands(20) Upper + ATR(14) -> Vùng SELL (Overbought Exhaustion)
   * - Lower Entry = Bands(20) Lower - ATR(14) -> Vùng BUY (Oversold Exhaustion)
   */
  async getBbAtrState(
    symbol = 'XAU',
    timeframe: EmaTimeframe = 'M5',
    bbPeriod = 20,
    bbStdDev = 2.0,
    atrPeriod = 14,
  ): Promise<BbAtrState> {
    const isGold = this.goldAliases.has(symbol.trim().toUpperCase());

    // 1. NGUỒN ƯU TIÊN SỐ 1: LIVE WEBSOCKET THỜI GIAN THỰC (0ms latency, khớp từng tick)
    if (isGold && timeframe === 'M5' && this.isWsConnected && !this.isLiveWsFresh()) {
      this.forceReconnectLiveWs('phát hiện dữ liệu WS bị cũ trong getBbAtrState');
    }

    if (
      isGold &&
      timeframe === 'M5' &&
      this.isLiveWsFresh() &&
      this.liveCandles.length >= 20 &&
      bbPeriod === 20 &&
      bbStdDev === 2.0 &&
      atrPeriod === 14
    ) {
      const closes = this.liveCandles.map((c) => c.close);
      const bb = this.calculateBollingerBands(closes, bbPeriod, bbStdDev);
      const atr = this.calculateAtr(this.liveCandles, atrPeriod);
      const rsi = this.calculateRsi(closes, 14);

      const last = this.liveCandles[this.liveCandles.length - 1];
      const prevCandle = this.liveCandles.length >= 2 ? this.liveCandles[this.liveCandles.length - 2] : undefined;
      const currentPrice = last.close;
      const candleHigh = last.high;
      const candleLow = last.low;
      const candleTime = normalizeCandleTimeMs(last.time);

      const upperEntry = bb.upper + atr;
      const lowerEntry = bb.lower - atr;
      const sellSl = upperEntry + atr;
      const buySl = lowerEntry - atr;
      const slDistance = atr;

      const distToUpper = upperEntry - currentPrice;
      const distToUpperPercent = Number(((distToUpper / currentPrice) * 100).toFixed(2));
      const distToLower = currentPrice - lowerEntry;
      const distToLowerPercent = Number(((distToLower / currentPrice) * 100).toFixed(2));

      const classified = classifySignalTier({
        price: currentPrice,
        high: candleHigh,
        low: candleLow,
        bbUpper: bb.upper,
        bbLower: bb.lower,
        atr,
        rsi,
        candle: last,
        prevCandle,
        nowMs: Date.now(),
        candleDurationMs: this.timeframeDurationMsMap[timeframe] || M5_DURATION_MS,
      });

      return {
        symbol: symbol.toUpperCase(),
        displaySymbol: 'XAU/USD (Vàng Forex - Live WebSocket 0ms)',
        assetType: 'GOLD',
        timeframe,
        candleTime,
        consecutiveTouches: this.consecutiveTouchCount,
        currentPrice: Number(currentPrice.toFixed(4)),
        candleHigh: Number(candleHigh.toFixed(4)),
        candleLow: Number(candleLow.toFixed(4)),
        bbPeriod,
        bbStdDev,
        bbUpper: Number(bb.upper.toFixed(4)),
        bbMiddle: Number(bb.middle.toFixed(4)),
        bbLower: Number(bb.lower.toFixed(4)),
        atrPeriod,
        atrValue: Number(atr.toFixed(2)),
        alertTier: classified.alertTier,
        tierReason: classified.tierReason,
        rejectionCandleTime: classified.rejectionCandleTime,
        rsiPeriod: 14,
        rsiValue: rsi,
        isRsiOversold: classified.isRsiOversold,
        isRsiOverbought: classified.isRsiOverbought,
        upperEntry: Number(upperEntry.toFixed(4)),
        lowerEntry: Number(lowerEntry.toFixed(4)),
        sellSl: Number(sellSl.toFixed(4)),
        buySl: Number(buySl.toFixed(4)),
        slDistance: Number(slDistance.toFixed(4)),
        distToUpper: Number(distToUpper.toFixed(4)),
        distToUpperPercent,
        distToLower: Number(distToLower.toFixed(4)),
        distToLowerPercent,
        signal: classified.signal,
        signalReason: classified.signalReason,
        updatedAt: new Date(),
      };
    }

    // 2. NGUỒN DỰ PHÒNG: TradingView Scanner API (OANDA XAU/USD)
    if (isGold && bbPeriod === 20 && bbStdDev === 2.0 && atrPeriod === 14) {
      const tvData = await this.fetchGoldFromTradingView(timeframe);
      if (tvData && tvData.currentPrice && tvData.bbUpper && tvData.bbLower && tvData.atrValue) {
        const currentPrice = tvData.currentPrice;
        const bbUpper = tvData.bbUpper;
        const bbLower = tvData.bbLower;
        const bbMiddle = tvData.bbMiddle || (bbUpper + bbLower) / 2;
        const atrValue = tvData.atrValue;
        const candleHigh = tvData.candleHigh || currentPrice;
        const candleLow = tvData.candleLow || currentPrice;

        const upperEntry = bbUpper + atrValue;
        const lowerEntry = bbLower - atrValue;
        const sellSl = upperEntry + atrValue;
        const buySl = lowerEntry - atrValue;
        const slDistance = atrValue;

        const distToUpper = upperEntry - currentPrice;
        const distToUpperPercent = Number(((distToUpper / currentPrice) * 100).toFixed(2));
        const distToLower = currentPrice - lowerEntry;
        const distToLowerPercent = Number(((distToLower / currentPrice) * 100).toFixed(2));

        const classified = classifySignalTier({
          price: currentPrice,
          high: candleHigh,
          low: candleLow,
          bbUpper,
          bbLower,
          atr: atrValue,
        });

        return {
          symbol: symbol.toUpperCase(),
          displaySymbol: 'XAU/USD (Vàng Forex - OANDA)',
          assetType: 'GOLD',
          timeframe,
          currentPrice: Number(currentPrice.toFixed(4)),
          candleHigh: Number(candleHigh.toFixed(4)),
          candleLow: Number(candleLow.toFixed(4)),
          bbPeriod,
          bbStdDev,
          bbUpper: Number(bbUpper.toFixed(4)),
          bbMiddle: Number(bbMiddle.toFixed(4)),
          bbLower: Number(bbLower.toFixed(4)),
          atrPeriod,
          atrValue: Number(atrValue.toFixed(4)),
          alertTier: classified.alertTier,
          tierReason: classified.tierReason,
          rejectionCandleTime: classified.rejectionCandleTime,
          upperEntry: Number(upperEntry.toFixed(4)),
          lowerEntry: Number(lowerEntry.toFixed(4)),
          sellSl: Number(sellSl.toFixed(4)),
          buySl: Number(buySl.toFixed(4)),
          slDistance: Number(slDistance.toFixed(4)),
          distToUpper: Number(distToUpper.toFixed(4)),
          distToUpperPercent,
          distToLower: Number(distToLower.toFixed(4)),
          distToLowerPercent,
          signal: classified.signal,
          signalReason: classified.signalReason,
          updatedAt: new Date(),
        };
      }
    }

    const { candles, currentPrice, displaySymbol, assetType } = await this.fetchCandles(
      symbol,
      timeframe,
      150,
    );

    const closes = candles.map((c) => c.close);
    const bb = this.calculateBollingerBands(closes, bbPeriod, bbStdDev);
    const atr = this.calculateAtr(candles, atrPeriod);
    const rsi = this.calculateRsi(closes, 14);

    // Tính ngưỡng Entry chiến lược
    const upperEntry = bb.upper + atr;
    const lowerEntry = bb.lower - atr;

    // Tính điểm Cắt Lỗ (Stop Loss - SL) bằng đúng 1 ATR
    const sellSl = upperEntry + atr;
    const buySl = lowerEntry - atr;
    const slDistance = atr;

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles.length >= 2 ? candles[candles.length - 2] : undefined;

    // Tính khoảng cách
    const distToUpper = upperEntry - currentPrice;
    const distToUpperPercent = Number(((distToUpper / currentPrice) * 100).toFixed(2));
    const distToLower = currentPrice - lowerEntry;
    const distToLowerPercent = Number(((distToLower / currentPrice) * 100).toFixed(2));

    const classified = classifySignalTier({
      price: currentPrice,
      high: lastCandle.high,
      low: lastCandle.low,
      bbUpper: bb.upper,
      bbLower: bb.lower,
      atr,
      rsi,
      candle: lastCandle,
      prevCandle,
      nowMs: Date.now(),
      candleDurationMs: this.timeframeDurationMsMap[timeframe] || M5_DURATION_MS,
    });

    return {
      symbol: symbol.toUpperCase(),
      displaySymbol,
      assetType,
      timeframe,
      candleTime: normalizeCandleTimeMs(lastCandle.time),
      currentPrice: Number(currentPrice.toFixed(4)),
      candleHigh: Number(lastCandle.high.toFixed(4)),
      candleLow: Number(lastCandle.low.toFixed(4)),
      bbPeriod,
      bbStdDev,
      bbUpper: Number(bb.upper.toFixed(4)),
      bbMiddle: Number(bb.middle.toFixed(4)),
      bbLower: Number(bb.lower.toFixed(4)),
      atrPeriod,
      atrValue: Number(atr.toFixed(2)),
      rsiPeriod: 14,
      rsiValue: rsi,
      isRsiOversold: classified.isRsiOversold,
      isRsiOverbought: classified.isRsiOverbought,
      alertTier: classified.alertTier,
      tierReason: classified.tierReason,
      rejectionCandleTime: classified.rejectionCandleTime,
      upperEntry: Number(upperEntry.toFixed(4)),
      lowerEntry: Number(lowerEntry.toFixed(4)),
      sellSl: Number(sellSl.toFixed(4)),
      buySl: Number(buySl.toFixed(4)),
      slDistance: Number(slDistance.toFixed(4)),
      distToUpper: Number(distToUpper.toFixed(4)),
      distToUpperPercent,
      distToLower: Number(distToLower.toFixed(4)),
      distToLowerPercent,
      signal: classified.signal,
      signalReason: classified.signalReason,
      updatedAt: new Date(),
    };
  }

  /**
   * Lấy trạng thái Bật/Tắt nhận cảnh báo BB+ATR M5 tự động của người dùng
   */
  async getUserBbAtrEnabled(chatId: string): Promise<boolean> {
    try {
      const user = await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.findUnique({
          where: { chatId },
          select: { bbAtrAlertEnabled: true },
        }),
      );
      if (user && typeof user.bbAtrAlertEnabled === 'boolean') {
        return user.bbAtrAlertEnabled;
      }
    } catch (e) {
      // Bỏ qua lỗi DB schema nếu cột chưa tồn tại
    }

    return this.userSettingFallback.get(chatId) ?? true;
  }

  /**
   * Bật/Tắt cài đặt nhận cảnh báo BB+ATR M5
   */
  async toggleUserBbAtrEnabled(chatId: string): Promise<boolean> {
    const current = await this.getUserBbAtrEnabled(chatId);
    const next = !current;
    return this.setUserBbAtrEnabled(chatId, next);
  }

  /**
   * Đặt trực tiếp trạng thái Bật (true) hoặc Tắt (false) nhận cảnh báo BB+ATR M5
   */
  async setUserBbAtrEnabled(chatId: string, enabled: boolean): Promise<boolean> {
    this.userSettingFallback.set(chatId, enabled);
    this.subscriberCache?.patch(chatId, { bbAtrAlertEnabled: enabled });

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.upsert({
          where: { chatId },
          update: { bbAtrAlertEnabled: enabled },
          create: { chatId, bbAtrAlertEnabled: enabled },
        }),
      );
    } catch (e) {
      // Fallback in-memory
    }

    return enabled;
  }

  /**
   * Lấy trạng thái Bật/Tắt riêng của Cảnh báo Tier 2 (Quét thanh khoản)
   */
  async getUserTier2Enabled(chatId: string): Promise<boolean> {
    try {
      const user = await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.findUnique({
          where: { chatId },
          select: { tier2AlertEnabled: true },
        }),
      );
      if (user && typeof user.tier2AlertEnabled === 'boolean') {
        return user.tier2AlertEnabled;
      }
    } catch (e) {}

    return this.userTier2Fallback.get(chatId) ?? true;
  }

  /**
   * Bật/Tắt riêng Cảnh báo Tier 2 (Quét thanh khoản High Probability)
   */
  async toggleUserTier2Enabled(chatId: string): Promise<boolean> {
    const current = await this.getUserTier2Enabled(chatId);
    const next = !current;
    return this.setUserTier2Enabled(chatId, next);
  }

  /**
   * Đặt trực tiếp trạng thái Bật (true) hoặc Tắt (false) nhận cảnh báo Tier 2
   */
  async setUserTier2Enabled(chatId: string, enabled: boolean): Promise<boolean> {
    this.userTier2Fallback.set(chatId, enabled);
    this.subscriberCache?.patch(chatId, { tier2AlertEnabled: enabled });

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.upsert({
          where: { chatId },
          update: { tier2AlertEnabled: enabled },
          create: { chatId, tier2AlertEnabled: enabled },
        }),
      );
    } catch (e) {}

    return enabled;
  }

  /**
   * Lấy cấu hình bộ lọc xu hướng trong ngày của User (BOTH, BUY_ONLY, SELL_ONLY)
   */
  async getUserBias(chatId: string): Promise<BbAtrBias> {
    try {
      const user = await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.findUnique({
          where: { chatId },
          select: { bbAtrBias: true },
        }),
      );
      if (user && user.bbAtrBias && ['BOTH', 'BUY_ONLY', 'SELL_ONLY'].includes(user.bbAtrBias)) {
        return user.bbAtrBias as BbAtrBias;
      }
    } catch (e) {
      // Bỏ qua lỗi DB schema nếu cột chưa tồn tại
    }

    return this.userBiasFallback.get(chatId) ?? 'BOTH';
  }

  /**
   * Cập nhật cấu hình bộ lọc xu hướng trong ngày của User
   */
  async setUserBias(chatId: string, bias: BbAtrBias): Promise<BbAtrBias> {
    this.userBiasFallback.set(chatId, bias);
    this.subscriberCache?.patch(chatId, { bbAtrBias: bias });

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.upsert({
          where: { chatId },
          update: { bbAtrBias: bias },
          create: { chatId, bbAtrBias: bias },
        }),
      );
    } catch (e) {
      // Fallback in-memory
    }

    return bias;
  }

  /**
   * Lấy trạng thái Bật/Tắt riêng của Cảnh báo Tier 0 (Chạm dải BB thường)
   */
  async getUserTier0Enabled(chatId: string): Promise<boolean> {
    if (this.userTier0Fallback.has(chatId)) {
      return this.userTier0Fallback.get(chatId)!;
    }

    try {
      const user = await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.findUnique({
          where: { chatId },
          select: { bbTier0AlertEnabled: true },
        }),
      );
      if (user && typeof user.bbTier0AlertEnabled === 'boolean') {
        this.userTier0Fallback.set(chatId, user.bbTier0AlertEnabled);
        return user.bbTier0AlertEnabled;
      }
    } catch (e) {
      // Bỏ qua lỗi DB schema nếu cột bbTier0AlertEnabled chưa push lên DB
    }

    return this.userTier0Fallback.get(chatId) ?? true;
  }

  /**
   * Bật/Tắt riêng Cảnh báo Tier 0 (Chạm dải BB thường — giữ nguyên Tier 1, 2A, 2B, 3)
   */
  async toggleUserTier0Enabled(chatId: string): Promise<boolean> {
    const current = await this.getUserTier0Enabled(chatId);
    const next = !current;
    return this.setUserTier0Enabled(chatId, next);
  }

  /**
   * Đặt trực tiếp trạng thái Bật (true) hoặc Tắt (false) nhận cảnh báo Tier 0
   */
  async setUserTier0Enabled(chatId: string, enabled: boolean): Promise<boolean> {
    this.userTier0Fallback.set(chatId, enabled);
    this.subscriberCache?.patch(chatId, { bbTier0AlertEnabled: enabled });

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.upsert({
          where: { chatId },
          update: { bbTier0AlertEnabled: enabled },
          create: { chatId, bbTier0AlertEnabled: enabled },
        }),
      );
    } catch (e) {
      // Fallback in-memory nếu cột chưa migrate
    }

    return enabled;
  }

  /**
   * Lấy danh sách tất cả ChatId người dùng có bật nhận cảnh báo tự động kèm bộ lọc Bias & Tier 0
   * TUYỆT ĐỐI KHÔNG GỬI NẾU NGƯỜI DÙNG ĐÃ TẮT CẢNH BÁO (bbAtrAlertEnabled = false)
   */
  async getAllUsersForGlobalAlert(): Promise<Array<{ chatId: string; bias: BbAtrBias; tier0Enabled: boolean }>> {
    try {
      let allUsers: Array<{
        chatId: string;
        bbAtrAlertEnabled: boolean;
        bbAtrBias: string;
        bbTier0AlertEnabled?: boolean;
      }> = [];

      const cachedUsers = this.subscriberCache?.isReady() ? this.subscriberCache.getAll() : null;
      try {
        if (cachedUsers) {
          allUsers = cachedUsers;
        } else {
          allUsers = await this.prisma.executeWithRetry(() =>
            this.prisma.telegramUser.findMany({
              select: { chatId: true, bbAtrAlertEnabled: true, bbAtrBias: true, bbTier0AlertEnabled: true },
            }),
          );
        }
      } catch (colErr) {
        // Fallback an toàn nếu cột bbTier0AlertEnabled chưa được push lên DB production
        allUsers = await this.prisma.executeWithRetry(() =>
          this.prisma.telegramUser.findMany({
            select: { chatId: true, bbAtrAlertEnabled: true, bbAtrBias: true },
          }),
        );
      }

      if (allUsers && allUsers.length > 0) {
        const knownDbChatIds = new Set(allUsers.map((u) => u.chatId));
        const result: Array<{ chatId: string; bias: BbAtrBias; tier0Enabled: boolean }> = [];

        for (const u of allUsers) {
          // Trạng thái BẬT/TẮT: Kiểm tra cả Database và Fallback bộ nhớ
          // Nếu một trong hai là false thì TUYỆT ĐỐI KHÔNG GỬI
          const isFallbackOff = this.userSettingFallback.get(u.chatId) === false;
          const isDbOff = u.bbAtrAlertEnabled === false;

          if (!isDbOff && !isFallbackOff) {
            const fbTier0 = this.userTier0Fallback.get(u.chatId);
            const tier0Enabled = fbTier0 !== undefined ? fbTier0 : u.bbTier0AlertEnabled !== false;
            result.push({
              chatId: u.chatId,
              bias: (u.bbAtrBias && ['BOTH', 'BUY_ONLY', 'SELL_ONLY'].includes(u.bbAtrBias)
                ? (u.bbAtrBias as BbAtrBias)
                : this.userBiasFallback.get(u.chatId) || 'BOTH'),
              tier0Enabled,
            });
          }
        }

        // CHỈ thêm activeChatIds nếu user đó CHƯA TỒN TẠI trong database (user mới tinh)
        for (const chatId of this.activeChatIds) {
          if (!knownDbChatIds.has(chatId)) {
            if (this.userSettingFallback.get(chatId) === true) {
              result.push({
                chatId,
                bias: this.userBiasFallback.get(chatId) || 'BOTH',
                tier0Enabled: this.userTier0Fallback.get(chatId) ?? true,
              });
            }
          }
        }

        return result;
      }
    } catch (e: any) {
      this.logger.warn(`Lỗi đọc DB users: ${e.message}. Đang dùng danh sách fallback active...`);
    }

    // Fallback khi DB lỗi
    const fallbackList: Array<{ chatId: string; bias: BbAtrBias; tier0Enabled: boolean }> = [];
    for (const chatId of this.activeChatIds) {
      if (this.userSettingFallback.get(chatId) === true) {
        fallbackList.push({
          chatId,
          bias: this.userBiasFallback.get(chatId) || 'BOTH',
          tier0Enabled: this.userTier0Fallback.get(chatId) ?? true,
        });
      }
    }
    return fallbackList;
  }

  /**
   * Lấy danh sách ChatId người dùng có BẬT Cảnh báo Tier 2 - High Probability
   * Yêu cầu: Kể cả user tắt cảnh báo BB, NWE hay SMC, chỉ cần user không tắt riêng Tier 2 thì vẫn gửi đến!
   */
  async getAllRegisteredUsersForTier2(): Promise<Array<{ chatId: string; bias: BbAtrBias }>> {
    const result: Array<{ chatId: string; bias: BbAtrBias }> = [];
    const knownDbChatIds = new Set<string>();

    try {
      const allUsers: any[] = this.subscriberCache?.isReady()
        ? this.subscriberCache.getAll()
        : await this.prisma.executeWithRetry(() =>
            this.prisma.telegramUser.findMany({
              select: { chatId: true, bbAtrBias: true, tier2AlertEnabled: true },
            }),
          );

      if (allUsers && allUsers.length > 0) {
        for (const u of allUsers) {
          knownDbChatIds.add(u.chatId);
          const isFallbackOff = this.userTier2Fallback.get(u.chatId) === false;
          const isDbOff = u.tier2AlertEnabled === false;

          // Nếu user chủ động tắt riêng Tier 2 thì loại trừ
          if (!isDbOff && !isFallbackOff) {
            result.push({
              chatId: u.chatId,
              bias: (u.bbAtrBias && ['BOTH', 'BUY_ONLY', 'SELL_ONLY'].includes(u.bbAtrBias)
                ? (u.bbAtrBias as BbAtrBias)
                : this.userBiasFallback.get(u.chatId) || 'BOTH'),
            });
          }
        }
      }
    } catch (e: any) {
      this.logger.warn(`Lỗi đọc DB users: ${e.message}`);
    }

    for (const chatId of this.activeChatIds) {
      if (!knownDbChatIds.has(chatId)) {
        if (this.userTier2Fallback.get(chatId) !== false) {
          result.push({
            chatId,
            bias: this.userBiasFallback.get(chatId) || 'BOTH',
          });
        }
      }
    }

    return result;
  }

  /**
   * Gửi tin nhắn Telegram song song theo batch (20-25 users/lượt) dùng Promise.allSettled()
   * để giảm độ trễ broadcast và log rõ chatId gặp lỗi.
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
          this.logger.warn(`Lỗi gửi BB+ATR alert tới chatId=${failedChatId}: ${reasonMsg}`);
        }
      });
    }

    return sentCount;
  }

  /**
   * VÒNG LẶP GLOBAL AUTO-SCANNER: Quét liên tục XAU/USD trên khung M5
   * Tự động phát hiện khi giá chạm 2 dải BB (Upper/Lower), khớp ngưỡng Entry (+/- 1 ATR) hoặc nến rút râu M5
   */
  async checkGlobalXauM5Alert(): Promise<boolean> {
    // Mutex/lock chống Race Condition giữa WebSocket callback và Cron 3s
    if (this.isCheckingGlobalXau) {
      return false;
    }
    this.isCheckingGlobalXau = true;

    try {
      const state = await this.getBbAtrState('XAU', 'M5');
      const now = Date.now();
      const candleTime = state.candleTime
        ? normalizeCandleTimeMs(state.candleTime)
        : Math.floor(now / M5_DURATION_MS) * M5_DURATION_MS;

      // Nếu WebSocket đang bị treo (stale) thì ép reconnect song song và dùng REST API ngay lượt này
      if (this.isWsConnected && !this.isLiveWsFresh()) {
        this.forceReconnectLiveWs('phát hiện dữ liệu cũ trong vòng quét M5');
      }

      // Log định kỳ mỗi 60 giây vào terminal để user luôn thấy bot đang hoạt động
      if (this.scanTickCount % 20 === 0) {
        const liveStatus = this.isLiveWsFresh() ? '⚡ LIVE WS (0ms)' : '🌐 REST API';
        const rsiText = state.rsiValue !== undefined ? ` | RSI: ${state.rsiValue}` : '';
        this.logger.log(
          `🔍 [XAU/USD M5 Scanner | ${liveStatus}] Giá: $${state.currentPrice} | BB: [${state.bbLower} - ${state.bbUpper}]${rsiText} | Trạng thái: ${state.signal}`,
        );
      }
      this.scanTickCount++;

      // Chống bắn trùng cho tín hiệu nến rút râu (Tier 2B / Tier 3):
      // Chỉ bỏ qua nếu rejectionCandleTime <= lastWickAlertCandleTime VÀ alertTier <= lastWickAlertTier
      // (cùng 1 cây nến vẫn cho phép upgrade Tier 2B -> Tier 3, nhưng không lặp lại ở đầu nến tiếp theo)
      const isWickSignal =
        state.tierReason === 'TIER_2B_M5_WICK' || state.tierReason === 'TIER_3_M5_WICK';
      if (
        isWickSignal &&
        state.rejectionCandleTime !== undefined &&
        state.rejectionCandleTime <= this.lastWickAlertCandleTime &&
        (state.alertTier || 0) <= this.lastWickAlertTier
      ) {
        if (state.rejectionCandleTime < candleTime) {
          // Tín hiệu rút râu đến từ prevCandle đã được báo -> đánh giá lại nến hiện tại không dùng prevCandle
          const reclassified = classifySignalTier({
            price: state.currentPrice,
            high: state.candleHigh,
            low: state.candleLow,
            bbUpper: state.bbUpper,
            bbLower: state.bbLower,
            atr: state.atrValue,
            rsi: state.rsiValue,
            nowMs: now,
            candleDurationMs: M5_DURATION_MS,
          });
          state.signal = reclassified.signal;
          state.alertTier = reclassified.alertTier;
          state.tierReason = reclassified.tierReason;
          state.signalReason = reclassified.signalReason;
          state.rejectionCandleTime = undefined;
        } else {
          return false;
        }
      }

      // Xử lý khi giá quay lại trong dải dao động an toàn
      if (state.signal === 'NORMAL') {
        if (this.lastGlobalSignal !== 'NORMAL') {
          this.logger.log(
            '✨ [XAU/USD M5] Giá đã quay trở lại bên trong dải Bollinger Bands an toàn. Đã sẵn sàng bắt nhịp chạm tiếp theo!',
          );
          this.lastGlobalSignal = 'NORMAL';
          this.consecutiveTouchCount = 0;
          this.lastCandleAlertLevel = 'NORMAL';
          this.lastAlertTier = 0;
        }
        return false;
      }

      const isSellSide =
        state.signal === 'SELL_CONFLUENCE' ||
        state.signal === 'ENTRY_SELL' ||
        state.signal === 'TOUCH_UPPER_BB' ||
        (state.signal as any) === 'SELL';
      const isBuySide =
        state.signal === 'BUY_CONFLUENCE' ||
        state.signal === 'ENTRY_BUY' ||
        state.signal === 'TOUCH_LOWER_BB' ||
        (state.signal as any) === 'BUY';

      // Quản lý cảnh báo theo từng nến M5:
      // 1. Nến M5 MỚI: BÁO NGAY!
      // 2. CÙNG NẾN: Nâng cấp Tier (0 -> 1 -> 2 -> 3): BÁO NÂNG CẤP NGAY!
      // 3. CÙNG NẾN: Nếu duy trì ngoài dải sau 90 giây cooldown -> Báo nhắc lại!
      const isNewCandle = candleTime > this.lastAlertCandleTime;
      const isUpgradeSignal = (state.alertTier || 0) > (this.lastAlertTier || 0);
      const isCooldownPassed = now - this.lastGlobalAlertTime > 90 * 1000;

      if (isNewCandle || isUpgradeSignal || isCooldownPassed) {
        if (isNewCandle) {
          if (this.lastGlobalSignal === state.signal) {
            this.consecutiveTouchCount++;
          } else {
            this.consecutiveTouchCount = 1;
          }
        }
        state.consecutiveTouches = this.consecutiveTouchCount;

        this.lastAlertCandleTime = candleTime;
        this.lastCandleAlertLevel = state.signal;
        this.lastGlobalSignal = state.signal;
        this.lastGlobalAlertTime = now;
        this.lastGlobalAlertPrice = state.currentPrice;
        this.lastAlertTier = state.alertTier || 0;

        // Cập nhật trạng thái chống trùng cho nến rút râu (áp dụng cho cả >= 80% thời gian nến lẫn prevCandle)
        if (
          (state.tierReason === 'TIER_2B_M5_WICK' || state.tierReason === 'TIER_3_M5_WICK') &&
          state.rejectionCandleTime !== undefined
        ) {
          this.lastWickAlertCandleTime = state.rejectionCandleTime;
          this.lastWickAlertTier = state.alertTier || 0;
        }

        // TIER 3 (VIP - BB ± ATR + NẾN RÚT RÂU M5):
        // Nếu user BẬT Tier VIP -> Báo cho user (kể cả user tắt cảnh báo BB hay tắt NWE/SMC)!
        // Nếu user TẮT riêng Tier VIP -> Không gửi cho user đó.
        // TIER 0, 1, 2 (bao gồm cả Tier 2A và Tier 2B): Gửi cho người dùng có BẬT cảnh báo BB
        const subscribers =
          state.alertTier === 3
            ? await this.getAllRegisteredUsersForTier2()
            : await this.getAllUsersForGlobalAlert();

        if (subscribers.length === 0) {
          this.logger.warn('⚠️ Có tín hiệu BB+ATR nhưng chưa tìm thấy người dùng nhận tin.');
          return false;
        }

        const alertMessage = this.renderAlertMessage(state, state.signal);

        // Với Tier 0: bỏ qua user đã tắt riêng Tier 0 (nhưng vẫn giữ lại cho Tier 1, 2A, 2B, 3)
        // Với Tier 0, 1, 2 (bao gồm Tier 2A & 2B): lọc theo Daily Trend Bias
        const isTier0 = (state.alertTier || 0) === 0;
        const eligibleChatIds = subscribers
          .filter((sub) => {
            if (state.alertTier === 3) return true;
            if (isTier0 && (sub as any).tier0Enabled === false) return false;
            if (isSellSide && sub.bias === 'BUY_ONLY') return false;
            if (isBuySide && sub.bias === 'SELL_ONLY') return false;
            return true;
          })
          .map((sub) => sub.chatId);

        if (eligibleChatIds.length === 0) {
          return false;
        }

        const sentCount = await this.broadcastTelegramInBatches(
          eligibleChatIds,
          alertMessage,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '📊 Xem Bảng BB+ATR M5', callback_data: 'bbatr_view:XAU:M5' },
                  { text: '⚙️ Bật/Tắt Cảnh Báo', callback_data: 'bbatr_toggle' },
                ],
              ],
            },
          },
          25,
        );

        // Ghi log vào Database (đảm bảo Entry/SL chuẩn xác cho cả Tier 2B tại biên BB)
        const isTier2B = state.alertTier === 2 && state.tierReason === 'TIER_2B_M5_WICK';
        const logEntryTarget = isTier2B
          ? isSellSide
            ? state.bbUpper
            : state.bbLower
          : isSellSide
          ? state.upperEntry
          : state.lowerEntry;
        const logSlPrice = isTier2B
          ? isSellSide
            ? Number((state.bbUpper + state.atrValue).toFixed(4))
            : Number((state.bbLower - state.atrValue).toFixed(4))
          : isSellSide
          ? state.sellSl
          : state.buySl;

        // SEND-FIRST, LOG-LATER: ghi DB bất đồng bộ, không chặn luồng báo SSS/CallMeBot phía sau
        void (async () => {
        try {
          await this.prisma.executeWithRetry(() =>
            this.prisma.bbAtrAlertLog.create({
              data: {
                symbol: state.symbol,
                timeframe: state.timeframe,
                signalType: state.signal,
                price: state.currentPrice,
                bbUpper: state.bbUpper,
                bbLower: state.bbLower,
                bbMiddle: state.bbMiddle,
                atr: state.atrValue,
                entryTarget: logEntryTarget,
                slPrice: logSlPrice,
                message: state.signalReason,
              },
            }),
          );
        } catch (dbErr: any) {
          this.logger.warn(`Ghi BbAtrAlertLog thất bại (bỏ qua): ${dbErr?.message}`);
        }
        })();

        const tierName =
          state.alertTier === 3
            ? 'TIER 3 (BB±ATR + M5 WICK 🔥🔥🔥)'
            : state.alertTier === 2
            ? state.tierReason === 'TIER_2B_M5_WICK'
              ? 'TIER 2B (BB + M5 WICK 🔥🔥)'
              : 'TIER 2A (BB±ATR + RSI 🔥🔥)'
            : state.alertTier === 1
            ? 'TIER 1 (BB+ATR 🔥)'
            : 'NORMAL TOUCH BB (🔔)';
        this.logger.log(
          `🔔 [BB+ATR M5 ALERT: ${tierName}] ${state.signal} XAU/USD tại giá $${state.currentPrice} -> Đã gửi thành công tới ${sentCount} người dùng.`,
        );

        // Báo cáo sự kiện Tier 3 sang SuperTierService để đánh giá Siêu Hợp Lưu TIER SSS
        if (state.alertTier === 3 && this.superTierService) {
          this.superTierService
            .reportTier3Event({
              source: 'BB_ATR',
              direction: isSellSide ? 'SELL' : 'BUY',
              triggeredAtMs: now,
              candleTimeMs: state.rejectionCandleTime ?? candleTime,
              currentPrice: state.currentPrice,
              slPrice: isSellSide ? state.sellSl : state.buySl,
              tp1Price: state.bbMiddle,
              summary: state.signalReason,
              details: {
                bbUpper: state.bbUpper,
                bbMiddle: state.bbMiddle,
                bbLower: state.bbLower,
                upperEntry: state.upperEntry,
                lowerEntry: state.lowerEntry,
                atrM5: state.atrValue,
                rsiValue: state.rsiValue,
              },
            })
            .catch((err) => {
              this.logger.warn(`Lỗi báo cáo BB Tier 3 sang SuperTierService: ${err.message}`);
            });
        }

        return true;
      }

      return false;
    } catch (err: any) {
      this.logger.error(`Lỗi trong checkGlobalXauM5Alert: ${err.message}`);
      return false;
    } finally {
      this.isCheckingGlobalXau = false;
    }
  }

  /**
   * Xử lý tín hiệu trực tiếp từ MT5 EA bắn qua Webhook (Độ trễ 0s tuyệt đối theo sàn người dùng)
   */
  async handleMt5WebhookAlert(body: any): Promise<{ success: boolean; message: string }> {
    try {
      // 1. Nếu là thông báo vào lệnh tự động từ MT5 Auto-Trader EA
      if (body.action) {
        const actionEmoji = body.action === 'BUY' ? '🟢🚀 [ĐÃ VÀO LỆNH BUY]' : '🔴🚀 [ĐÃ VÀO LỆNH SELL]';
        const msg =
          `🤖 <b>MT5 AUTO-TRADER: ${actionEmoji}</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `💎 <b>Tài sản:</b> <code>${body.symbol || 'XAU/USD'}</code> (${body.broker || 'MT5 Live'})\n` +
          `💵 <b>Giá khớp lệnh:</b> <code>$${Number(body.price).toFixed(2)}</code>\n` +
          `📦 <b>Khối lượng:</b> <code>${body.lot} Lot</code>\n` +
          `🛑 <b>Cắt Lỗ (SL):</b> <code>$${Number(body.sl).toFixed(2)}</code>\n` +
          `🎯 <b>Chốt Lời (TP):</b> <code>$${Number(body.tp).toFixed(2)}</code>\n` +
          `⚡ <b>Lý do:</b> <i>${body.reason || 'Chiến lược BB + ATR'}</i>\n` +
          `⏱ <b>Thời gian:</b> <code>${new Date().toLocaleTimeString('vi-VN')}</code>`;

        const subscribers = await this.getAllUsersForGlobalAlert();
        const sentCount = await this.broadcastTelegramInBatches(
          subscribers.map((sub) => sub.chatId),
          msg,
          undefined,
          25,
        );
        return { success: true, message: `Đã phát thông báo khớp lệnh EA tới ${sentCount} người dùng.` };
      }

      const timeframe = (body.timeframe || 'M5').toUpperCase();
      const price = Number(body.price);
      const signalType = (body.signal || 'TOUCH_LOWER_BB') as BbAtrSignalType;
      const bbUpper = Number(body.bbUpper);
      const bbLower = Number(body.bbLower);
      const bbMiddle = Number(body.bbMiddle) || (bbUpper + bbLower) / 2;
      const atrValue = Number(body.atr) || 8.0;
      const rsiValue = body.rsi !== undefined ? Number(body.rsi) : undefined;

      const upperEntry = bbUpper + atrValue;
      const lowerEntry = bbLower - atrValue;
      const sellSl = upperEntry + atrValue;
      const buySl = lowerEntry - atrValue;
      const slDistance = atrValue;

      const state: BbAtrState = {
        symbol: 'XAU',
        displaySymbol: `XAU/USD (Sàn MT5: ${body.broker || 'Live'})`,
        assetType: 'GOLD',
        timeframe: timeframe as EmaTimeframe,
        currentPrice: price,
        candleHigh: price,
        candleLow: price,
        bbPeriod: 20,
        bbStdDev: 2.0,
        bbUpper,
        bbMiddle,
        bbLower,
        atrPeriod: 14,
        atrValue,
        rsiPeriod: 14,
        rsiValue,
        isRsiOversold: rsiValue !== undefined ? rsiValue <= 30 : false,
        isRsiOverbought: rsiValue !== undefined ? rsiValue >= 70 : false,
        upperEntry,
        lowerEntry,
        sellSl,
        buySl,
        slDistance,
        distToUpper: upperEntry - price,
        distToUpperPercent: Number((((upperEntry - price) / price) * 100).toFixed(2)),
        distToLower: price - lowerEntry,
        distToLowerPercent: Number((((price - lowerEntry) / price) * 100).toFixed(2)),
        signal: signalType,
        signalReason: body.message || 'Khớp điều kiện chiến lược từ MT5 EA',
        updatedAt: new Date(),
      };

      const subscribers = await this.getAllUsersForGlobalAlert();
      const isSellSide =
        signalType === 'TOUCH_UPPER_BB' ||
        signalType === 'ENTRY_SELL' ||
        signalType === 'SELL_CONFLUENCE' ||
        (signalType as any) === 'SELL';
      const isBuySide =
        signalType === 'TOUCH_LOWER_BB' ||
        signalType === 'ENTRY_BUY' ||
        signalType === 'BUY_CONFLUENCE' ||
        (signalType as any) === 'BUY';
      const alertMessage = this.renderAlertMessage(state, signalType);

      const eligibleChatIds = subscribers
        .filter((sub) => {
          if (isSellSide && sub.bias === 'BUY_ONLY') return false;
          if (isBuySide && sub.bias === 'SELL_ONLY') return false;
          return true;
        })
        .map((sub) => sub.chatId);

      const sentCount = await this.broadcastTelegramInBatches(eligibleChatIds, alertMessage, undefined, 25);

      return {
        success: true,
        message: `Đã phát cảnh báo từ MT5 tới ${sentCount} người dùng.`,
      };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  /**
   * VÒNG LẶP KIỂM TRA CẢNH BÁO BB+ATR CÁ NHÂN (Người dùng tự đặt riêng cho BTC, ETH...)
   */
  async checkAllActiveBbAtrAlerts(): Promise<number> {
    try {
      let activeAlerts: any[] = [];
      try {
        activeAlerts = await this.prisma.executeWithRetry(() =>
          this.prisma.bbAtrAlert.findMany({
            where: { status: 'ACTIVE' },
          }),
        );
      } catch (e) {
        return 0; // Chưa migrate bảng
      }

      if (activeAlerts.length === 0) return 0;

      // Gom nhóm theo symbol + timeframe để chỉ fetch dữ liệu 1 lần
      const groupMap = new Map<string, any[]>();
      for (const alert of activeAlerts) {
        const key = `${alert.symbol}:${alert.timeframe}`;
        if (!groupMap.has(key)) {
          groupMap.set(key, []);
        }
        groupMap.get(key)!.push(alert);
      }

      let triggeredCount = 0;

      for (const [key, alerts] of groupMap.entries()) {
        const [symbol, timeframe] = key.split(':');
        try {
          const state = await this.getBbAtrState(symbol, timeframe as EmaTimeframe);

          if (state.signal !== 'NORMAL') {
            const isSellSide =
              state.signal === 'TOUCH_UPPER_BB' ||
              state.signal === 'ENTRY_SELL' ||
              state.signal === 'SELL_CONFLUENCE' ||
              (state.signal as any) === 'SELL';
            const isBuySide =
              state.signal === 'TOUCH_LOWER_BB' ||
              state.signal === 'ENTRY_BUY' ||
              state.signal === 'BUY_CONFLUENCE' ||
              (state.signal as any) === 'BUY';

            for (const alert of alerts) {
              // Kiểm tra bộ lọc xu hướng của alert (nếu có)
              const alertBias = alert.bias || 'BOTH';
              if (isSellSide && alertBias === 'BUY_ONLY') continue;
              if (isBuySide && alertBias === 'SELL_ONLY') continue;

              if (alert.lastSignal !== state.signal) {
                triggeredCount++;
                await this.handleTriggerCustomAlert(alert, state, state.signal);
              }
            }
          } else {
            // Reset lastSignal nếu giá đã quay lại bình thường
            for (const alert of alerts) {
              if (alert.lastSignal && alert.lastSignal !== 'NORMAL') {
                await this.prisma.bbAtrAlert.update({
                  where: { id: alert.id },
                  data: { lastSignal: 'NORMAL' },
                }).catch(() => {});
              }
            }
          }
        } catch (err: any) {
          this.logger.debug(`Lỗi quét BB+ATR custom cho ${key}: ${err.message}`);
        }
      }

      return triggeredCount;
    } catch (e: any) {
      this.logger.error(`Lỗi trong checkAllActiveBbAtrAlerts: ${e.message}`);
      return 0;
    }
  }

  /**
   * Kích hoạt và gửi thông báo cảnh báo cá nhân
   */
  private async handleTriggerCustomAlert(alert: any, state: BbAtrState, signalType: BbAtrSignalType) {
    try {
      await this.prisma.bbAtrAlert.update({
        where: { id: alert.id },
        data: {
          lastSignal: signalType,
          lastSignalPrice: state.currentPrice,
          lastTriggeredAt: new Date(),
        },
      });

      const message = this.renderAlertMessage(state, signalType);

      await this.telegramService.sendMessage(alert.chatId, message, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📋 Danh sách cảnh báo', callback_data: 'bbatr_list' },
              { text: `🗑 Tắt cảnh báo này (#${alert.id})`, callback_data: `bbatr_del:${alert.id}` },
            ],
          ],
        },
      });
    } catch (err: any) {
      this.logger.error(`Lỗi trigger custom BB+ATR alert #${alert.id}: ${err.message}`);
    }
  }

  /**
   * Tạo cảnh báo BB+ATR mới cho người dùng
   */
  async createBbAtrAlert(dto: CreateBbAtrAlertDto): Promise<CreateBbAtrAlertResult> {
    try {
      const { chatId, username, symbol } = dto;
      const timeframe = dto.timeframe || 'M5';
      const bbPeriod = dto.bbPeriod || 20;
      const bbStdDev = dto.bbStdDev || 2.0;
      const atrPeriod = dto.atrPeriod || 14;
      const bias = dto.bias || 'BOTH';

      const state = await this.getBbAtrState(symbol, timeframe, bbPeriod, bbStdDev, atrPeriod);

      const existing = await this.prisma.bbAtrAlert.findFirst({
        where: {
          chatId,
          symbol: state.symbol,
          timeframe,
          status: 'ACTIVE',
        },
      });

      if (existing) {
        return {
          success: false,
          message: `⚠️ Bạn đã có cảnh báo <b>BB+ATR</b> cho <b>${state.displaySymbol}</b> trên khung <b>${this.timeframeLabels[timeframe]}</b> đang hoạt động rồi! (Mã #${existing.id})`,
        };
      }

      const alert = await this.prisma.bbAtrAlert.create({
        data: {
          chatId,
          username,
          symbol: state.symbol,
          displaySymbol: state.displaySymbol,
          assetType: state.assetType,
          timeframe,
          bbPeriod,
          bbStdDev,
          atrPeriod,
          bias,
          lastSignal: state.signal,
          lastSignalPrice: state.currentPrice,
          status: 'ACTIVE',
        },
      });

      const successMessage = `
✅ <b>ĐÃ CÀI ĐẶT CẢNH BÁO CHIẾN LƯỢC BB + ATR THÀNH CÔNG!</b> 🎯

💎 <b>Tài sản:</b> <code>${state.displaySymbol}</code>
⏳ <b>Khung thời gian:</b> <b>${this.timeframeLabels[timeframe]}</b>
📈 <b>Chỉ báo:</b> <b>Bollinger Bands(20)</b> & <b>ATR(14)</b>
💵 <b>Giá hiện tại:</b> <code>${this.formatPrice(state.currentPrice, state.assetType)}</code>

📊 <b>KẾ HOẠCH ENTRY & CẮT LỖ (SL = 1 ATR):</b>
• 🔴 <b>Upper Entry (Bán):</b> <code>${this.formatPrice(state.upperEntry, state.assetType)}</code>
  ↳ <b>Stop Loss (SL):</b> <code>${this.formatPrice(state.sellSl, state.assetType)}</code> (+${this.formatPrice(state.slDistance, state.assetType)})
• 🟢 <b>Lower Entry (Mua):</b> <code>${this.formatPrice(state.lowerEntry, state.assetType)}</code>
  ↳ <b>Stop Loss (SL):</b> <code>${this.formatPrice(state.buySl, state.assetType)}</code> (-${this.formatPrice(state.slDistance, state.assetType)})

🔔 <i>Bot sẽ tự động quét liên tục và báo NGAY LẬP TỨC khi giá thị trường chạm hoặc khớp 1 trong 2 ngưỡng trên!</i>
      `.trim();

      return {
        success: true,
        message: successMessage,
        alert,
        state,
      };
    } catch (err: any) {
      this.logger.error(`Lỗi tạo BB+ATR alert: ${err.message}`);
      return {
        success: false,
        message: `⚠️ Không thể tạo cảnh báo: ${err.message}`,
      };
    }
  }

  /**
   * Lấy danh sách các cảnh báo BB+ATR đang hoạt động của người dùng
   */
  async getUserActiveAlerts(chatId: string): Promise<ActiveBbAtrAlertDetail[]> {
    try {
      const alerts = await this.prisma.bbAtrAlert.findMany({
        where: {
          chatId,
          status: 'ACTIVE',
        },
        orderBy: { createdAt: 'desc' },
      });

      const results: ActiveBbAtrAlertDetail[] = [];

      for (const alert of alerts) {
        let state: BbAtrState | undefined;
        let statusText = 'Đang theo dõi';

        try {
          state = await this.getBbAtrState(
            alert.symbol,
            alert.timeframe as EmaTimeframe,
            alert.bbPeriod,
            alert.bbStdDev,
            alert.atrPeriod,
          );
          if (
            state.signal === 'SELL' ||
            state.signal === 'ENTRY_SELL' ||
            state.signal === 'SELL_CONFLUENCE' ||
            state.signal === 'TOUCH_UPPER_BB'
          ) {
            const targetPrice =
              state.alertTier === 2 && state.tierReason === 'TIER_2B_M5_WICK'
                ? state.bbUpper
                : state.upperEntry;
            statusText = `🔴 Tín hiệu BÁN (${state.signal} | $${targetPrice})`;
          } else if (
            state.signal === 'BUY' ||
            state.signal === 'ENTRY_BUY' ||
            state.signal === 'BUY_CONFLUENCE' ||
            state.signal === 'TOUCH_LOWER_BB'
          ) {
            const targetPrice =
              state.alertTier === 2 && state.tierReason === 'TIER_2B_M5_WICK'
                ? state.bbLower
                : state.lowerEntry;
            statusText = `🟢 Tín hiệu MUA (${state.signal} | $${targetPrice})`;
          } else {
            statusText = `⚪ An toàn (Upper: $${state.upperEntry} | Lower: $${state.lowerEntry})`;
          }
        } catch (e) {
          statusText = 'Đang chờ quét...';
        }

        results.push({
          alert,
          state,
          statusText,
        });
      }

      return results;
    } catch (e) {
      return [];
    }
  }

  /**
   * Xóa một cảnh báo BB+ATR theo ID
   */
  async deleteAlert(chatId: string, alertId: number): Promise<{ success: boolean; message: string }> {
    try {
      const alert = await this.prisma.bbAtrAlert.findFirst({
        where: { id: alertId, chatId },
      });

      if (!alert) {
        return {
          success: false,
          message: `⚠️ Không tìm thấy cảnh báo BB+ATR mã <code>#${alertId}</code> hoặc bạn không có quyền.`,
        };
      }

      await this.prisma.bbAtrAlert.update({
        where: { id: alertId },
        data: { status: 'CANCELLED' },
      });

      return {
        success: true,
        message: `🗑 Đã hủy cảnh báo BB+ATR cho <b>${alert.displaySymbol}</b> (${alert.timeframe}).`,
      };
    } catch (e: any) {
      return {
        success: false,
        message: `⚠️ Lỗi khi hủy cảnh báo: ${e.message}`,
      };
    }
  }

  /**
   * Xóa tất cả cảnh báo BB+ATR của người dùng
   */
  async clearUserAlerts(chatId: string): Promise<{ success: boolean; count: number; message: string }> {
    try {
      const res = await this.prisma.bbAtrAlert.updateMany({
        where: { chatId, status: 'ACTIVE' },
        data: { status: 'CANCELLED' },
      });

      return {
        success: true,
        count: res.count,
        message: `🗑 Đã hủy thành công tất cả <b>${res.count}</b> cảnh báo BB+ATR của bạn.`,
      };
    } catch (e: any) {
      return {
        success: false,
        count: 0,
        message: `⚠️ Lỗi: ${e.message}`,
      };
    }
  }

  /**
   * Định dạng giá hiển thị có dấu $ và phân tách nghìn
   */
  formatPrice(price: number, assetType: string): string {
    if (assetType === 'GOLD') {
      return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    if (assetType === 'CRYPTO') {
      if (price >= 1000) {
        return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      } else if (price >= 1) {
        return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
      } else {
        return `$${price.toFixed(6)}`;
      }
    }
    return `${price}`;
  }

  /**
   * Định dạng số thuần KHÔNG có dấu $ hay dấu phẩy nghìn — 1 chạm trong Telegram để copy dán thẳng vào MT5/Exness
   */
  formatRawPrice(price: number, assetType: string): string {
    if (assetType === 'GOLD') {
      return price.toFixed(2);
    }
    if (assetType === 'CRYPTO') {
      if (Math.abs(price) >= 1000) {
        return price.toFixed(2);
      } else if (Math.abs(price) >= 1) {
        return price.toFixed(4);
      } else {
        return price.toFixed(6);
      }
    }
    return `${Number(price.toFixed(2))}`;
  }

  /**
   * Lấy tên mã ngắn gọn cho tiêu đề trading card (VD: "XAU/USD", "BTC/USDT")
   */
  private getShortSymbol(state: BbAtrState): string {
    const raw = (state.displaySymbol || state.symbol || 'XAU/USD').split(' (')[0].trim();
    return raw || 'XAU/USD';
  }

  /**
   * Format tin nhắn bảng Dashboard xem thông số trực quan BB+ATR (tối ưu đọc nhanh & 1-chạm copy)
   */
  renderDashboardMessage(
    state: BbAtrState,
    isAlertEnabled: boolean,
    bias: BbAtrBias = 'BOTH',
    isTier2Enabled = true,
    isTier0Enabled = true,
  ): string {
    const isGold = state.assetType === 'GOLD';
    const shortSym = this.getShortSymbol(state);
    const fmt = (v: number) => this.formatRawPrice(v, state.assetType);

    let biasText = '⚖️ 2 Chiều (Buy / Sell)';
    if (bias === 'BUY_ONLY') biasText = '🟢 Chỉ MUA (Buy Only)';
    if (bias === 'SELL_ONLY') biasText = '🔴 Chỉ BÁN (Sell Only)';

    const nowStr = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date());

    const isSellSignal =
      state.signal === 'ENTRY_SELL' ||
      state.signal === 'SELL_CONFLUENCE' ||
      state.signal === 'TOUCH_UPPER_BB' ||
      (state.signal as any) === 'SELL';

    let signalBadge = '⚪ TRUNG TÍNH (Trong dải BB)';
    if (state.alertTier === 3) {
      signalBadge = isSellSignal
        ? '🔥🔥🔥 [TIER 3 VIP] SELL — BB UPPER + ATR + RÚT RÂU M5'
        : '🔥🔥🔥 [TIER 3 VIP] BUY — BB LOWER - ATR + RÚT RÂU M5';
    } else if (state.alertTier === 2) {
      if (state.tierReason === 'TIER_2B_M5_WICK') {
        signalBadge = isSellSignal
          ? '🔥🔥 [TIER 2B] SELL — RÚT RÂU M5 TẠI BB UPPER'
          : '🔥🔥 [TIER 2B] BUY — RÚT RÂU M5 TẠI BB LOWER';
      } else {
        signalBadge = isSellSignal
          ? '🔥🔥 [TIER 2A] SELL — BB+ATR + RSI ≥ 70'
          : '🔥🔥 [TIER 2A] BUY — BB-ATR + RSI ≤ 30';
      }
    } else if (state.alertTier === 1) {
      signalBadge = isSellSignal
        ? '🔥 [TIER 1] SELL — KHỚP BB UPPER + ATR'
        : '🔥 [TIER 1] BUY — KHỚP BB LOWER - ATR';
    } else if (state.signal === 'SELL_CONFLUENCE') {
      signalBadge = '🎯 CHẠM BB TRÊN + RSI ≥ 70';
    } else if (state.signal === 'BUY_CONFLUENCE') {
      signalBadge = '🎯 CHẠM BB DƯỚI + RSI ≤ 30';
    } else if (state.signal === 'TOUCH_UPPER_BB') {
      signalBadge = '🔴 CHẠM BB TRÊN (Bands Upper)';
    } else if (state.signal === 'TOUCH_LOWER_BB') {
      signalBadge = '🟢 CHẠM BB DƯỚI (Bands Lower)';
    }

    const distUpSign = state.distToUpper >= 0 ? '+' : '-';
    const distDownSign = state.distToLower >= 0 ? '-' : '+';

    let msg = `🎯 <b>BB(20) + ATR(14) • ${shortSym} (${state.timeframe})</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💵 <b>GIÁ MKT:</b> <code>${fmt(state.currentPrice)}</code>  <i>(${nowStr})</i>\n\n`;

    msg += `🔴 <b>SELL ENTRY:</b> <code>${fmt(state.upperEntry)}</code>  <i>(${distUpSign}${fmt(Math.abs(state.distToUpper))} · ${distUpSign}${Math.abs(state.distToUpperPercent)}%)</i>\n`;
    msg += `   🛑 <b>SL:</b> <code>${fmt(state.sellSl)}</code>  <i>(-${fmt(state.slDistance)} · 1 ATR)</i>\n\n`;

    msg += `🟢 <b>BUY ENTRY:</b> <code>${fmt(state.lowerEntry)}</code>  <i>(${distDownSign}${fmt(Math.abs(state.distToLower))} · ${distDownSign}${Math.abs(state.distToLowerPercent)}%)</i>\n`;
    msg += `   🛑 <b>SL:</b> <code>${fmt(state.buySl)}</code>  <i>(-${fmt(state.slDistance)} · 1 ATR)</i>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;

    msg += `📊 <b>BB:</b> <code>${fmt(state.bbLower)}</code> | <code>${fmt(state.bbMiddle)}</code> | <code>${fmt(state.bbUpper)}</code>\n`;
    let metricLine = `📐 <b>ATR:</b> <code>${state.atrValue.toFixed(2)}</code>`;
    if (state.rsiValue !== undefined) {
      const rsiTag =
        state.rsiValue <= 30 ? '🟢 Quá Bán' : state.rsiValue >= 70 ? '🔴 Quá Mua' : '⚪';
      metricLine += ` · <b>RSI:</b> <code>${state.rsiValue.toFixed(2)}</code> <i>${rsiTag}</i>`;
    }
    msg += `${metricLine}\n`;
    msg += `⚡ <b>Trạng thái:</b> <b>${signalBadge}</b>\n`;
    msg += `🧭 <b>Bias:</b> <b>${biasText}</b>\n`;
    if (isGold) {
      msg += `🔔 <b>Auto M5:</b> <b>${isAlertEnabled ? '🟢 BẬT' : '⚪ TẮT'}</b> · <b>Tier 0:</b> <b>${isTier0Enabled ? '🟢' : '⚪'}</b> · <b>Tier 3:</b> <b>${isTier2Enabled ? '🟢' : '⚪'}</b>`;
    }

    return msg;
  }

  /**
   * Format tin nhắn cảnh báo tối ưu tốc độ vào lệnh (< 2 giây đọc, 1 chạm copy giá dán MT5)
   */
  renderAlertMessage(state: BbAtrState, signalType: BbAtrSignalType): string {
    const isSell =
      signalType === 'ENTRY_SELL' ||
      signalType === 'SELL_CONFLUENCE' ||
      signalType === 'TOUCH_UPPER_BB' ||
      (signalType as any) === 'SELL';

    const tier = state.alertTier ?? 0;
    const isTier3 = tier === 3;
    const isTier2B = tier === 2 && state.tierReason === 'TIER_2B_M5_WICK';
    const isTier2A = tier === 2 && !isTier2B;
    const isTier1 = tier === 1;

    const shortSym = this.getShortSymbol(state);
    const fmt = (v: number) => this.formatRawPrice(v, state.assetType);

    // Tier 2B vào lệnh tại biên BB Upper / BB Lower (SL = 1 ATR từ biên BB)
    // Tier 0, 1, 2A, 3 dùng mốc Entry mở rộng BB Upper + ATR / BB Lower - ATR (SL = 1 ATR)
    const entryPrice = isTier2B
      ? isSell
        ? state.bbUpper
        : state.bbLower
      : isSell
      ? state.upperEntry
      : state.lowerEntry;
    const slPrice = isTier2B
      ? isSell
        ? Number((state.bbUpper + state.slDistance).toFixed(4))
        : Number((state.bbLower - state.slDistance).toFixed(4))
      : isSell
      ? state.sellSl
      : state.buySl;
    const tp1Price = state.bbMiddle;
    const tp2Price = isSell
      ? Number((entryPrice - 2 * state.slDistance).toFixed(4))
      : Number((entryPrice + 2 * state.slDistance).toFixed(4));

    const slDist = Math.abs(entryPrice - slPrice);
    const tp1RawDiff = isSell ? entryPrice - tp1Price : tp1Price - entryPrice;
    const tp1Sign = tp1RawDiff >= 0 ? '+' : '-';
    const tp1RR = slDist > 0 ? (Math.abs(tp1RawDiff) / slDist).toFixed(1) : '0.0';
    const tp2Dist = Math.abs(tp2Price - entryPrice);

    const mktDiff = state.currentPrice - entryPrice;
    const mktSign = mktDiff >= 0 ? '+' : '-';

    const nowStr = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date());

    const dirDot = isSell ? '🔴🔴' : '🟢🟢';
    const dirAction = isSell ? 'SELL' : 'BUY';

    let headerLine = '';
    let entryTag = isSell ? 'BB Upper + ATR' : 'BB Lower - ATR';
    let reasonLine = '';

    if (isTier3) {
      headerLine = `${dirDot} <b>${dirAction} ${shortSym}</b> • 🔥🔥🔥 <b>TIER 3 VIP</b> (${state.timeframe})`;
      reasonLine = isSell
        ? `Đâm vượt <b>BB Upper + ATR</b> (<code>${fmt(state.upperEntry)}</code>) + <b>rút râu M5</b> từ chối mạnh`
        : `Đâm thủng <b>BB Lower - ATR</b> (<code>${fmt(state.lowerEntry)}</code>) + <b>rút chân M5</b> từ chối mạnh`;
    } else if (isTier2B) {
      headerLine = `${dirDot} <b>${dirAction} ${shortSym}</b> • 🔥🔥 <b>TIER 2B</b> (${state.timeframe})`;
      entryTag = isSell ? 'BB Upper' : 'BB Lower';
      reasonLine = isSell
        ? `<b>Rút râu M5</b> từ chối trực tiếp tại biên <b>BB Upper</b> (<code>${fmt(state.bbUpper)}</code>)`
        : `<b>Rút chân M5</b> từ chối trực tiếp tại biên <b>BB Lower</b> (<code>${fmt(state.bbLower)}</code>)`;
    } else if (isTier2A) {
      headerLine = `${dirDot} <b>${dirAction} ${shortSym}</b> • 🔥🔥 <b>TIER 2A</b> (${state.timeframe})`;
      const rsiStr = state.rsiValue !== undefined ? state.rsiValue.toFixed(2) : isSell ? '≥ 70' : '≤ 30';
      reasonLine = isSell
        ? `Khớp <b>BB Upper + ATR</b> (<code>${fmt(state.upperEntry)}</code>) + <b>RSI Quá Mua</b> (<code>${rsiStr}</code>)`
        : `Khớp <b>BB Lower - ATR</b> (<code>${fmt(state.lowerEntry)}</code>) + <b>RSI Quá Bán</b> (<code>${rsiStr}</code>)`;
    } else if (isTier1) {
      headerLine = `${isSell ? '🔴' : '🟢'} <b>${dirAction} ${shortSym}</b> • 🔥 <b>TIER 1</b> (${state.timeframe})`;
      reasonLine = isSell
        ? `Giá bung vượt vùng <b>BB Upper + ATR</b> (<code>${fmt(state.upperEntry)}</code>)`
        : `Giá đâm thủng vùng <b>BB Lower - ATR</b> (<code>${fmt(state.lowerEntry)}</code>)`;
    } else {
      headerLine = `🔔${isSell ? '🔴' : '🟢'} <b>CANH ${dirAction} ${shortSym}</b> • <b>TIER 0</b> (${state.timeframe})`;
      entryTag = isSell ? 'Limit BB + ATR' : 'Limit BB - ATR';
      reasonLine = isSell
        ? `Chạm dải <b>BB Upper</b> (<code>${fmt(state.bbUpper)}</code>) — canh rút râu hoặc chờ Limit <b>BB + ATR</b>`
        : `Chạm dải <b>BB Lower</b> (<code>${fmt(state.bbLower)}</code>) — canh rút chân hoặc chờ Limit <b>BB - ATR</b>`;
    }

    let msg = `${headerLine}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    if (state.consecutiveTouches && state.consecutiveTouches > 1) {
      msg += `⚠️ <b>Nến chạm liên tiếp #${state.consecutiveTouches}</b>\n`;
    }

    // KHỐI VÀO LỆNH NGAY TRÊN CÙNG — ĐỌC TRONG 2 GIÂY, 1 CHẠM COPY GIÁ DÁN MT5
    msg += `🎯 <b>ENTRY:</b> <code>${fmt(entryPrice)}</code> <i>(${entryTag})</i>\n`;
    msg += `🛑 <b>SL:</b> <code>${fmt(slPrice)}</code> <b>(-${fmt(slDist)})</b> <i>· 1 ATR</i>\n`;
    msg += `✅ <b>TP1:</b> <code>${fmt(tp1Price)}</code> <i>(${tp1Sign}${fmt(Math.abs(tp1RawDiff))} · BB Mid · 1:${tp1RR})</i>\n`;
    msg += `✅ <b>TP2:</b> <code>${fmt(tp2Price)}</code> <i>(+${fmt(tp2Dist)} · R:R 1:2)</i>\n`;
    msg += `💵 <b>Giá MKT:</b> <code>${fmt(state.currentPrice)}</code> <i>(${mktSign}${fmt(Math.abs(mktDiff))} vs Entry)</i>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;

    // THÔNG SỐ GỌN 3 DÒNG ĐỂ XÁC NHẬN NHANH
    msg += `📌 <b>Khớp:</b> ${reasonLine}\n`;
    msg += `📊 <b>BB:</b> <code>${fmt(state.bbLower)}</code> | <code>${fmt(state.bbMiddle)}</code> | <code>${fmt(state.bbUpper)}</code>\n`;
    let footerLine = `📐 <b>ATR:</b> <code>${state.atrValue.toFixed(2)}</code>`;
    if (state.rsiValue !== undefined) {
      footerLine += ` · <b>RSI:</b> <code>${state.rsiValue.toFixed(2)}</code>`;
    }
    footerLine += ` · 🕒 <code>${nowStr}</code>`;
    msg += footerLine;

    return msg;
  }
}
