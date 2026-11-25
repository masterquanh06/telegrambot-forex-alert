import { Injectable, Logger, Inject, Optional, forwardRef, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
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
  SmcMtfAlertPayload,
  UserSmcSettings,
} from './smc.interface';
import { CandleData } from '../indicator/bb-atr.interface';
import { M15_DURATION_MS, normalizeCandleTimeMs } from '../indicator/signal-classifier';
import {
  calculateWilderAtr,
  classifySmcMtfTier,
  SMC_MTF_OB_TIMEFRAMES,
} from './smc-mtf-classifier';
import { SuperTierService } from '../common/super-tier.service';
import { SubscriberCacheService } from '../common/subscriber-cache.service';
import { createLeadingTrailingThrottle } from '../common/throttle';
import { CallMeBotService } from '../common/callmebot.service';

@Injectable()
export class SmcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmcService.name);

  // TradingView Live Multi-Timeframe WebSocket (TVC:GOLD — 500 nến mỗi khung, khớp chuẩn chart TradingView)
  private tvWs: any = null;
  private isTvWsConnected = false;
  private isTvWsConnecting = false;
  private isDestroyed = false;
  private tvWsReconnectTimer: NodeJS.Timeout | null = null;
  private tvWsWatchdogTimer: NodeJS.Timeout | null = null;
  private lastTvWsMessageAt = 0;
  private tvWsConnectingSince = 0;
  private readonly TV_WS_WATCHDOG_TICK_MS = 5_000;
  private readonly TV_WS_PING_INTERVAL_MS = Math.max(5_000, Number(process.env.WS_PING_INTERVAL_MS) || 15_000);
  private readonly TV_WS_STALE_TIMEOUT_MS = Math.max(15_000, Number(process.env.WS_STALE_TIMEOUT_MS) || 35_000);
  private readonly TV_WS_CLOCK_JUMP_THRESHOLD_MS = 30_000;
  private readonly TV_WS_RECONNECT_BASE_DELAY_MS = 1_000;
  private readonly TV_WS_RECONNECT_MAX_DELAY_MS = 30_000;
  private lastTvWatchdogTickAt = 0;
  private lastTvWsPingAt = 0;
  private tvWsReconnectAttempt = 0;
  private tvWsHasEverOpened = false;
  private tvWsNeedsPostReconnectScan = false;
  private tvWsReconnectAt = 0;
  private readonly tvSessionToTf = new Map<string, SmcTimeframe>();
  private readonly liveTvCandlesMap = new Map<SmcTimeframe, CandleData[]>();
  private readonly inFlightTvFetch = new Map<string, Promise<CandleData[] | null>>();
  private lastDataSource: 'TVC:GOLD' | 'BINANCE' = 'TVC:GOLD';

  // Memoize detectOrderBlocks theo (timeframe, nến cuối) để quét MTF 1s/lần không tốn CPU
  private readonly obMemoCache = new Map<
    SmcTimeframe,
    {
      key: string;
      result: {
        activeDemand: OrderBlock[];
        activeSupply: OrderBlock[];
        keyLevels: KeyLevel[];
        touchingDemand: OrderBlock | null;
        touchingSupply: OrderBlock | null;
      };
    }
  >();

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
      lastTier?: 1 | 2 | 3;
    }
  >();

  // Mutex chống Race Condition cho vòng quét SMC/NWE
  private isCheckingSmc = false;

  // Event-driven MTF scan: kích hoạt từ tick WS (throttle 1000ms), dùng chung mutex isCheckingSmc với cron
  private readonly MTF_EVENT_TFS = new Set<string>(['M15', 'M30', 'H1', 'H4']);
  private readonly mtfEventThrottle = createLeadingTrailingThrottle(() => this.runMtfScanFromTick(), 1000);

  // State quản lý Hợp lưu Chéo Khung (MTF: NWE H1 + OB M15/M30/H1/H4 -> Tier 2 & Tier 3 Rút râu M15)
  private lastMtfSignal: 'NORMAL' | 'CONFLUENCE_SELL' | 'CONFLUENCE_BUY' = 'NORMAL';
  private lastMtfTier: 0 | 2 | 3 = 0;
  private lastMtfAlertTime = 0;
  private lastMtfAlertCandleTime = 0;
  private lastMtfWickCandleTime = 0;
  private lastMtfWickTier = 0;

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

  readonly tradingViewIntervalMap: Record<SmcTimeframe, string> = {
    M1: '1',
    M5: '5',
    M15: '15',
    M30: '30',
    H1: '60',
    H4: '240',
    D1: '1D',
  };

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TelegramService))
    private readonly telegramService: TelegramService,
    @Optional()
    private readonly superTierService?: SuperTierService,
    @Optional()
    private readonly callMeBotService?: CallMeBotService,
    @Optional()
    private readonly subscriberCache?: SubscriberCacheService,
  ) {}

  onModuleInit() {
    this.isDestroyed = false;
    this.initTradingViewMultiTfStream();
    this.startTvWsWatchdog();
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    this.stopTradingViewMultiTfStream();
  }

  /**
   * Kiểm tra WebSocket đa khung TVC:GOLD còn nhận dữ liệu/heartbeat mới không
   * (Chống Zombie Socket đóng băng nến khi Mac sleep hoặc đổi mạng)
   */
  private isTvWsFresh(): boolean {
    return (
      this.isTvWsConnected &&
      this.tvWs?.readyState === 1 &&
      this.lastTvWsMessageAt > 0 &&
      Date.now() - this.lastTvWsMessageAt < this.TV_WS_STALE_TIMEOUT_MS
    );
  }

  private isMtfLiveReady(): boolean {
    if (!this.isTvWsFresh()) return false;
    for (const tf of this.MTF_EVENT_TFS) {
      if ((this.liveTvCandlesMap.get(tf as SmcTimeframe)?.length ?? 0) < 50) return false;
    }
    return true;
  }

  private runMtfScanFromTick() {
    if (this.isDestroyed || this.isCheckingSmc || !this.isMtfLiveReady()) return;
    this.isCheckingSmc = true;
    this.checkMtfNweH1ObAlert()
      .catch((e: any) => this.logger.debug(`Event MTF scan lỗi: ${e?.message}`))
      .finally(() => {
        this.isCheckingSmc = false;
      });
  }

  private startTvWsWatchdog() {
    if (this.tvWsWatchdogTimer) return;
    this.lastTvWatchdogTickAt = Date.now();
    this.tvWsWatchdogTimer = setInterval(() => {
      if (this.isDestroyed) return;
      const now = Date.now();
      const tickDelta = this.lastTvWatchdogTickAt > 0 ? now - this.lastTvWatchdogTickAt : 0;
      this.lastTvWatchdogTickAt = now;

      if (tickDelta > this.TV_WS_CLOCK_JUMP_THRESHOLD_MS && (this.tvWs || this.isTvWsConnecting)) {
        this.forceReconnectTvWs(`phát hiện clock jump/sleep (${Math.round(tickDelta / 1000)}s)`);
        return;
      }

      if (this.tvWs) {
        const isOpen = this.tvWs.readyState === 1;
        const idleMs = this.lastTvWsMessageAt > 0 ? now - this.lastTvWsMessageAt : 0;

        if (this.isTvWsConnecting && this.tvWsConnectingSince > 0 && now - this.tvWsConnectingSince >= 20_000) {
          this.forceReconnectTvWs('treo ở trạng thái kết nối (handshake > 20s)');
          return;
        }

        if (!isOpen && !this.isTvWsConnecting) {
          this.forceReconnectTvWs('socket không ở trạng thái OPEN');
          return;
        }

        if (this.isTvWsConnected && this.lastTvWsMessageAt > 0 && idleMs >= this.TV_WS_STALE_TIMEOUT_MS) {
          this.forceReconnectTvWs(`không nhận dữ liệu/heartbeat suốt ${Math.round(idleMs / 1000)}s (zombie socket)`);
          return;
        }

        if (isOpen && now - this.lastTvWsPingAt >= this.TV_WS_PING_INTERVAL_MS) {
          this.lastTvWsPingAt = now;
          try {
            this.tvWs.ping();
          } catch (e) {
            this.forceReconnectTvWs('gửi WebSocket ping thất bại');
          }
        }
      } else if (!this.isTvWsConnecting && !this.tvWsReconnectTimer) {
        this.initTradingViewMultiTfStream();
      }
    }, this.TV_WS_WATCHDOG_TICK_MS);
  }

  private computeTvWsReconnectDelayMs(): number {
    const exp = Math.min(
      this.TV_WS_RECONNECT_MAX_DELAY_MS,
      this.TV_WS_RECONNECT_BASE_DELAY_MS * Math.pow(2, this.tvWsReconnectAttempt),
    );
    const jitter = Math.floor(Math.random() * 500);
    return exp + jitter;
  }

  private forceReconnectTvWs(reason: string) {
    if (this.isDestroyed) return;
    this.logger.warn(`⚠️ [SMC/NWE Live WS] Phát hiện kết nối treo (${reason}). Đang ép ngắt và kết nối lại...`);

    const staleWs = this.tvWs;
    this.tvWs = null;
    this.isTvWsConnected = false;
    this.isTvWsConnecting = false;
    this.tvWsConnectingSince = 0;
    this.lastTvWsMessageAt = 0;
    this.lastTvWsPingAt = 0;
    if (this.tvWsReconnectAt === 0) {
      this.tvWsReconnectAt = Date.now();
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

    if (this.tvWsReconnectTimer) {
      clearTimeout(this.tvWsReconnectTimer);
      this.tvWsReconnectTimer = null;
    }

    this.scheduleTvWsReconnect();
  }

  /** Đồng bộ ngay cài đặt NWE/SMC/Tier2 của user vào SubscriberCache (RAM) */
  private syncSubscriberCache(chatId: string, s: UserSmcSettings) {
    this.subscriberCache?.patch(chatId, {
      nweAlertEnabled: s.nweAlertEnabled,
      nweTimeframes: [...(s.nweTimeframes || s.timeframes || [])],
      smcAlertEnabled: s.smcAlertEnabled,
      smcTimeframes: [...(s.smcTimeframes || s.timeframes || [])],
      tier2AlertEnabled: s.tier2AlertEnabled !== false,
    });
  }

  registerActiveChat(chatId: string) {
    if (chatId) {
      this.activeChatIds.add(chatId);
    }
  }

  /**
   * Kết nối 1 luồng WebSocket duy nhất tới TradingView (TVC:GOLD) đăng ký đồng thời 6 khung
   * (M5, M15, M30, H1, H4, D1 — mỗi khung 500 nến) để tính NWE & SMC OB chuẩn 100% chart TradingView (0ms latency).
   */
  private initTradingViewMultiTfStream() {
    if (this.isDestroyed || this.isTvWsConnecting || this.isTvWsConnected) return;
    this.isTvWsConnecting = true;
    this.tvWsConnectingSince = Date.now();

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
      this.tvWs = ws;

      const createMsg = (func: string, args: any[]) => {
        const json = JSON.stringify({ m: func, p: args });
        return '~m~' + json.length + '~m~' + json;
      };

      ws.on('open', () => {
        if (this.tvWs !== ws) return;
        this.isTvWsConnected = true;
        this.isTvWsConnecting = false;
        const openNow = Date.now();
        this.lastTvWsMessageAt = openNow;
        this.lastTvWsPingAt = openNow;
        if (this.tvWsHasEverOpened) {
          this.tvWsNeedsPostReconnectScan = true;
        }
        this.tvWsHasEverOpened = true;
        this.tvSessionToTf.clear();
        this.liveTvCandlesMap.clear();
        this.obMemoCache.clear();
        this.logger.log(
          '🟢 [SMC/NWE Live WS] Đã kết nối TradingView TVC:GOLD đa khung (M5, M15, M30, H1, H4, D1 — 500 nến/khung)!',
        );

        ws.send(createMsg('set_auth_token', ['unauthorized_user_token']));
        for (const tf of this.supportedTimeframes) {
          const tvInterval = this.tradingViewIntervalMap[tf];
          const cs = `cs_smc_${tf}_${Math.random().toString(36).substring(2, 8)}`;
          this.tvSessionToTf.set(cs, tf);
          ws.send(createMsg('chart_create_session', [cs, '']));
          ws.send(
            createMsg('resolve_symbol', [cs, 'sds_sym_1', '={"symbol":"TVC:GOLD","adjustment":"splits"}']),
          );
          ws.send(createMsg('create_series', [cs, 'sds_1', 's1', 'sds_sym_1', tvInterval, 500, '']));
        }
      });

      ws.on('pong', () => {
        if (this.tvWs !== ws) return;
        this.lastTvWsMessageAt = Date.now();
      });

      ws.on('message', (data: any) => {
        if (this.tvWs !== ws) return;
        this.lastTvWsMessageAt = Date.now();

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
              const sessionId = msg.p?.[0];
              const tf = this.tvSessionToTf.get(sessionId);
              const sds = msg.p?.[1]?.sds_1;
              if (tf && sds?.s && Array.isArray(sds.s) && sds.s.length > 0) {
                this.tvWsReconnectAttempt = 0;
                this.handleTvCandlesUpdate(tf, sds.s);
                if (msg.m === 'timescale_update' && this.tvWsNeedsPostReconnectScan && this.isMtfLiveReady()) {
                  this.tvWsNeedsPostReconnectScan = false;
                  const elapsedMs = this.tvWsReconnectAt > 0 ? Date.now() - this.tvWsReconnectAt : 0;
                  this.tvWsReconnectAt = 0;
                  this.logger.log(
                    `🔄 [SMC/NWE Live WS] Đã đồng bộ lại nến đa khung sau reconnect${elapsedMs > 0 ? ` (${elapsedMs}ms)` : ''}. Đang quét tín hiệu ngay...`,
                  );
                  this.checkAllSmcAlerts().catch((err) => {
                    this.logger.warn(`Lỗi quét SMC ngay sau WS reconnect: ${err.message}`);
                  });
                } else if (this.MTF_EVENT_TFS.has(tf)) {
                  this.mtfEventThrottle.trigger();
                }
              }
            }
          } catch (e) {}
        }
      });

      ws.on('close', () => {
        if (this.tvWs !== ws) return;
        this.tvWs = null;
        this.isTvWsConnected = false;
        this.isTvWsConnecting = false;
        this.lastTvWsMessageAt = 0;
        this.scheduleTvWsReconnect();
      });

      ws.on('error', (err: any) => {
        if (this.tvWs !== ws) return;
        this.logger.warn(`⚠️ [SMC/NWE Live WS] Mất kết nối TradingView: ${err.message}. Đang kết nối lại...`);
        this.tvWs = null;
        this.isTvWsConnected = false;
        this.isTvWsConnecting = false;
        this.lastTvWsMessageAt = 0;
        try {
          ws.terminate?.();
        } catch (e) {}
        this.scheduleTvWsReconnect();
      });
    } catch (err: any) {
      this.logger.error(`Không thể khởi chạy SMC/NWE TradingView WS: ${err.message}`);
      this.isTvWsConnecting = false;
      this.scheduleTvWsReconnect();
    }
  }

  private scheduleTvWsReconnect() {
    if (this.isDestroyed || this.tvWsReconnectTimer) return;
    const delayMs = this.computeTvWsReconnectDelayMs();
    this.tvWsReconnectAttempt++;
    if (this.tvWsReconnectAt === 0) {
      this.tvWsReconnectAt = Date.now();
    }
    this.logger.warn(`🔄 [SMC/NWE Live WS] Lên lịch reconnect lần #${this.tvWsReconnectAttempt} sau ${delayMs}ms...`);
    this.tvWsReconnectTimer = setTimeout(() => {
      this.tvWsReconnectTimer = null;
      this.initTradingViewMultiTfStream();
    }, delayMs);
  }

  private stopTradingViewMultiTfStream() {
    this.mtfEventThrottle.cancel();
    if (this.tvWsWatchdogTimer) {
      clearInterval(this.tvWsWatchdogTimer);
      this.tvWsWatchdogTimer = null;
    }
    if (this.tvWsReconnectTimer) {
      clearTimeout(this.tvWsReconnectTimer);
      this.tvWsReconnectTimer = null;
    }
    if (this.tvWs) {
      try {
        if (typeof this.tvWs.terminate === 'function') {
          this.tvWs.terminate();
        } else {
          this.tvWs.close();
        }
      } catch (e) {}
      this.tvWs = null;
    }
    this.isTvWsConnected = false;
    this.isTvWsConnecting = false;
    this.tvWsConnectingSince = 0;
    this.lastTvWsMessageAt = 0;
    this.lastTvWatchdogTickAt = 0;
    this.lastTvWsPingAt = 0;
    this.tvWsNeedsPostReconnectScan = false;
    this.obMemoCache.clear();
  }

  private handleTvCandlesUpdate(tf: SmcTimeframe, rows: any[]) {
    let list = this.liveTvCandlesMap.get(tf);
    if (!list) {
      list = [];
      this.liveTvCandlesMap.set(tf, list);
    }

    for (const row of rows) {
      if (!row || !Array.isArray(row.v) || row.v.length < 5) continue;
      const t = Number(row.v[0]) * 1000;
      const candle: CandleData = {
        time: t,
        open: Number(row.v[1]),
        high: Number(row.v[2]),
        low: Number(row.v[3]),
        close: Number(row.v[4]),
        volume: Number(row.v[5] || 0),
      };

      const idx = list.findIndex((c) => c.time === t);
      if (idx >= 0) {
        list[idx].high = Math.max(list[idx].high, candle.high);
        list[idx].low = Math.min(list[idx].low, candle.low);
        list[idx].close = candle.close;
        list[idx].volume = candle.volume;
      } else {
        list.push(candle);
        // Giữ tối đa 550 nến để đảm bảo luôn đủ 500 nến cho công thức Pine Script NWE
        if (list.length > 550) {
          list.shift();
        }
      }
    }

    if (list.length > 1 && list[list.length - 1].time < list[list.length - 2].time) {
      list.sort((a, b) => a.time - b.time);
    }

    if (list.length > 0) {
      this.lastDataSource = 'TVC:GOLD';
    }
  }

  /**
   * Tải nhanh 1 lần từ TradingView WS (dùng khi live stream vừa khởi động chưa nạp xong hoặc trong script test)
   */
  private async fetchCandlesFromTradingViewOnce(
    timeframe: SmcTimeframe,
    limit = 500,
    symbol = 'TVC:GOLD',
  ): Promise<CandleData[] | null> {
    const key = `${symbol}:${timeframe}:${limit}`;
    if (this.inFlightTvFetch.has(key)) {
      return this.inFlightTvFetch.get(key)!;
    }

    const promise = new Promise<CandleData[] | null>((resolve) => {
      let ws: any = null;
      let settled = false;
      const finish = (val: CandleData[] | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ws) {
          try {
            ws.close();
          } catch (e) {}
        }
        this.inFlightTvFetch.delete(key);
        resolve(val);
      };

      const timer = setTimeout(() => finish(null), 6000);

      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const WebSocket = require('ws');
        ws = new WebSocket('wss://data.tradingview.com/socket.io/websocket', {
          headers: {
            Origin: 'https://www.tradingview.com',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          },
        });

        const createMsg = (func: string, args: any[]) => {
          const json = JSON.stringify({ m: func, p: args });
          return '~m~' + json.length + '~m~' + json;
        };

        const cs = `cs_once_${timeframe}_${Math.random().toString(36).substring(2, 8)}`;
        const tvInterval = this.tradingViewIntervalMap[timeframe] || '60';

        ws.on('open', () => {
          ws.send(createMsg('set_auth_token', ['unauthorized_user_token']));
          ws.send(createMsg('chart_create_session', [cs, '']));
          ws.send(
            createMsg('resolve_symbol', [cs, 'sds_sym_1', `={"symbol":"${symbol}","adjustment":"splits"}`]),
          );
          ws.send(createMsg('create_series', [cs, 'sds_1', 's1', 'sds_sym_1', tvInterval, limit, '']));
        });

        ws.on('message', (data: any) => {
          const packets = data.toString().split(/~m~\d+~m~/).filter(Boolean);
          for (const packet of packets) {
            if (packet.startsWith('~h~')) {
              if (ws && ws.readyState === 1) {
                ws.send('~m~' + packet.length + '~m~' + packet);
              }
              continue;
            }
            try {
              const msg = JSON.parse(packet);
              if (msg.m === 'timescale_update' && msg.p?.[1]?.sds_1?.s?.length) {
                const candles: CandleData[] = msg.p[1].sds_1.s
                  .filter((r: any) => r && Array.isArray(r.v) && r.v.length >= 5)
                  .map((r: any) => ({
                    time: Number(r.v[0]) * 1000,
                    open: Number(r.v[1]),
                    high: Number(r.v[2]),
                    low: Number(r.v[3]),
                    close: Number(r.v[4]),
                    volume: Number(r.v[5] || 0),
                  }))
                  .sort((a: CandleData, b: CandleData) => a.time - b.time);

                if (candles.length > 0) {
                  finish(candles);
                  return;
                }
              }
            } catch (e) {}
          }
        });

        ws.on('error', () => finish(null));
      } catch (e) {
        finish(null);
      }
    });

    this.inFlightTvFetch.set(key, promise);
    return promise;
  }

  /**
   * Tải dữ liệu nến cho Vàng (XAU/USD) theo khung thời gian (mặc định 500 nến chuẩn Pine Script NWE)
   * Ưu tiên: 1. TradingView Live WS (TVC:GOLD, 0ms) -> 2. TV One-Shot WS -> 3. Binance PAXGUSDT fallback
   */
  async fetchCandles(timeframe: SmcTimeframe = 'M15', limit = 500): Promise<CandleData[]> {
    // 1. Nguồn ưu tiên số 1: Live WebSocket TradingView TVC:GOLD (0ms latency)
    const liveCandles = this.liveTvCandlesMap.get(timeframe);
    if (this.isTvWsFresh() && liveCandles && liveCandles.length >= Math.min(limit, 50)) {
      this.lastDataSource = 'TVC:GOLD';
      return liveCandles.length > limit ? liveCandles.slice(-limit) : liveCandles;
    }
    if (this.isTvWsConnected && !this.isTvWsFresh()) {
      this.forceReconnectTvWs(`dữ liệu khung ${timeframe} đã cũ`);
    }

    const cacheKey = `XAU:${timeframe}`;
    const now = Date.now();

    if (this.klinesCache.has(cacheKey)) {
      const cached = this.klinesCache.get(cacheKey)!;
      if (now - cached.time < 8000 && cached.candles.length >= Math.min(limit, 50)) {
        return cached.candles;
      }
    }

    // 2. Nguồn ưu tiên số 2: TradingView One-Shot WS (TVC:GOLD)
    const tvCandles = await this.fetchCandlesFromTradingViewOnce(timeframe, limit, 'TVC:GOLD');
    if (tvCandles && tvCandles.length > 0) {
      this.lastDataSource = 'TVC:GOLD';
      this.klinesCache.set(cacheKey, { candles: tvCandles, time: now });
      return tvCandles;
    }

    // 3. Nguồn dự phòng: Binance PAXGUSDT
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

        this.lastDataSource = 'BINANCE';
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
   * Khớp chính xác 100% Pine Script v5 "Nadaraya-Watson Envelope + Dynamic S/R" (repaint = true):
   * - Lấy tối đa 500 nến gần nhất (i = 0 .. math.min(499, n - 1))
   * - Tính đường cong mượt y2[i] riêng cho TỪNG nến i bằng trọng số đối xứng gauss(i - j, h)
   * - sae = sum(|src[i] - y2[i]|) / math.min(499, n - 1) * mult
   * - Upper Band = y2[0] + sae, Lower Band = y2[0] - sae
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

    const maxIdx = Math.min(499, n - 1);
    const count = maxIdx + 1;

    // src[i] = candles[n - 1 - i].close (i = 0 là nến hiện tại, giống Pine Script src[i])
    const src = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      src[i] = candles[n - 1 - i].close;
    }

    // Precompute bảng Gaussian gauss(|i - j|, h) để chạy 500x500 cực nhanh (~1-2ms)
    const gaussTable = new Float64Array(count);
    const denom = 2 * h * h;
    for (let d = 0; d < count; d++) {
      gaussTable[d] = Math.exp(-(d * d) / denom);
    }

    let saeSum = 0;
    let kernelValue = src[0];

    for (let i = 0; i < count; i++) {
      let sum = 0;
      let sumw = 0;
      for (let j = 0; j < count; j++) {
        const w = gaussTable[i >= j ? i - j : j - i];
        sum += src[j] * w;
        sumw += w;
      }
      const y2 = sum / sumw;
      if (i === 0) {
        kernelValue = y2;
      }
      saeSum += Math.abs(src[i] - y2);
    }

    const mae = maxIdx > 0 ? saeSum / maxIdx : 0;
    const bandWidth = mae * mult;

    const upperBand = kernelValue + bandWidth;
    const lowerBand = kernelValue - bandWidth;

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

    const firstCandle = candles[0];
    const lastCandle = candles[n - 1];
    const memoKey = `${n}:${firstCandle.time}:${lastCandle.time}:${lastCandle.open}:${lastCandle.high}:${lastCandle.low}:${lastCandle.close}`;
    const memoized = this.obMemoCache.get(timeframe);
    if (memoized && memoized.key === memoKey) {
      return memoized.result;
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

    const result = {
      activeDemand,
      activeSupply,
      keyLevels,
      touchingDemand,
      touchingSupply,
    };
    this.obMemoCache.set(timeframe, { key: memoKey, result });
    return result;
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

    const candles = await this.fetchCandles(timeframe, 500);
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

    // Phân tích đơn khung luôn là Tier 1; Tier 2 (MTF NWE H1 + OB đa khung) & Tier 3 (+ Rút râu M15)
    // được xử lý riêng trong luồng Hợp lưu Chéo Khung (checkMtfNweH1ObAlert).
    const alertTier: 1 | 2 | 3 = 1;

    const result: SmcAnalysisResult = {
      symbol: 'XAU',
      displaySymbol:
        this.lastDataSource === 'TVC:GOLD'
          ? 'XAU/USD (Vàng Forex - TVC:GOLD)'
          : 'XAU/USD (Vàng Forex - Binance)',
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
            nweTimeframes: true,
            smcAlertEnabled: true,
            smcTimeframes: true,
            tier2AlertEnabled: true,
          },
        }),
      );

      if (user) {
        const nweTfs = (user.nweTimeframes as SmcTimeframe[]) || ['M5', 'M15', 'H1', 'H4'];
        const smcTfs = (user.smcTimeframes as SmcTimeframe[]) || ['M5', 'M15', 'H1', 'H4'];
        const settings: UserSmcSettings = {
          nweAlertEnabled: user.nweAlertEnabled ?? true,
          nweTimeframes: nweTfs,
          smcAlertEnabled: user.smcAlertEnabled ?? true,
          smcTimeframes: smcTfs,
          timeframes: smcTfs,
          tier2AlertEnabled: user.tier2AlertEnabled ?? true,
        };
        this.userSettingsFallback.set(chatId, settings);
        return settings;
      }
    } catch (e: any) {
      // Bỏ qua lỗi DB schema nếu chưa migrate cột mới
    }

    const defaultSettings: UserSmcSettings = {
      nweAlertEnabled: true,
      nweTimeframes: ['M5', 'M15', 'H1', 'H4'],
      smcAlertEnabled: true,
      smcTimeframes: ['M5', 'M15', 'H1', 'H4'],
      timeframes: ['M5', 'M15', 'H1', 'H4'],
      tier2AlertEnabled: true,
    };
    this.userSettingsFallback.set(chatId, defaultSettings);
    return defaultSettings;
  }

  /**
   * Bật/Tắt Cảnh báo Quét Thanh Khoản Tier 2 (High Probability)
   */
  async toggleTier2(chatId: string): Promise<UserSmcSettings> {
    const current = await this.getUserSettings(chatId);
    current.tier2AlertEnabled = current.tier2AlertEnabled === false ? true : false;
    this.userSettingsFallback.set(chatId, current);
    this.syncSubscriberCache(chatId, current);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.update({
          where: { chatId },
          data: { tier2AlertEnabled: current.tier2AlertEnabled },
        }),
      );
    } catch (e) {}

    return current;
  }

  /**
   * Đặt trực tiếp trạng thái Bật/Tắt Cảnh báo Tier 2
   */
  async setTier2(chatId: string, enabled: boolean): Promise<UserSmcSettings> {
    const current = await this.getUserSettings(chatId);
    current.tier2AlertEnabled = enabled;
    this.userSettingsFallback.set(chatId, current);
    this.syncSubscriberCache(chatId, current);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.update({
          where: { chatId },
          data: { tier2AlertEnabled: enabled },
        }),
      );
    } catch (e) {}

    return current;
  }

  /**
   * Bật/Tắt Cảnh báo Nadaraya-Watson Envelope (NWE)
   */
  async toggleNwe(chatId: string): Promise<UserSmcSettings> {
    const current = await this.getUserSettings(chatId);
    current.nweAlertEnabled = !current.nweAlertEnabled;
    this.userSettingsFallback.set(chatId, current);
    this.syncSubscriberCache(chatId, current);

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
   * Đặt trực tiếp trạng thái Bật/Tắt NWE
   */
  async setNwe(chatId: string, enabled: boolean): Promise<UserSmcSettings> {
    const current = await this.getUserSettings(chatId);
    current.nweAlertEnabled = enabled;
    this.userSettingsFallback.set(chatId, current);
    this.syncSubscriberCache(chatId, current);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.update({
          where: { chatId },
          data: { nweAlertEnabled: enabled },
        }),
      );
    } catch (e) {}

    return current;
  }

  /**
   * Bật/Tắt từng khung thời gian riêng cho NWE (M5, M15, M30, H1, H4, D1)
   */
  async toggleNweTimeframe(chatId: string, tf: SmcTimeframe): Promise<UserSmcSettings> {
    const current = await this.getUserSettings(chatId);
    if (!current.nweTimeframes) current.nweTimeframes = ['M5', 'M15', 'H1', 'H4'];
    if (current.nweTimeframes.includes(tf)) {
      current.nweTimeframes = current.nweTimeframes.filter((t) => t !== tf);
    } else {
      current.nweTimeframes.push(tf);
    }
    this.userSettingsFallback.set(chatId, current);
    this.syncSubscriberCache(chatId, current);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.update({
          where: { chatId },
          data: { nweTimeframes: current.nweTimeframes },
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
    this.syncSubscriberCache(chatId, current);

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
   * Đặt trực tiếp trạng thái Bật/Tắt Order Block
   */
  async setSmc(chatId: string, enabled: boolean): Promise<UserSmcSettings> {
    const current = await this.getUserSettings(chatId);
    current.smcAlertEnabled = enabled;
    this.userSettingsFallback.set(chatId, current);
    this.syncSubscriberCache(chatId, current);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.update({
          where: { chatId },
          data: { smcAlertEnabled: enabled },
        }),
      );
    } catch (e) {}

    return current;
  }

  /**
   * Bật/Tắt từng khung thời gian riêng cho Order Block (M5, M15, M30, H1, H4, D1)
   */
  async toggleSmcTimeframe(chatId: string, tf: SmcTimeframe): Promise<UserSmcSettings> {
    const current = await this.getUserSettings(chatId);
    if (!current.smcTimeframes) current.smcTimeframes = ['M5', 'M15', 'H1', 'H4'];
    if (current.smcTimeframes.includes(tf)) {
      current.smcTimeframes = current.smcTimeframes.filter((t) => t !== tf);
    } else {
      current.smcTimeframes.push(tf);
    }
    current.timeframes = current.smcTimeframes;
    this.userSettingsFallback.set(chatId, current);
    this.syncSubscriberCache(chatId, current);

    try {
      await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.update({
          where: { chatId },
          data: { smcTimeframes: current.smcTimeframes },
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
    this.syncSubscriberCache(chatId, current);

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
    this.syncSubscriberCache(chatId, current);

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
    this.syncSubscriberCache(chatId, current);

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
      const users: any[] = this.subscriberCache?.isReady()
        ? this.subscriberCache.getAll()
        : await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.findMany({
          select: {
            chatId: true,
            nweAlertEnabled: true,
            nweTimeframes: true,
            smcAlertEnabled: true,
            smcTimeframes: true,
            tier2AlertEnabled: true,
          },
        }),
      );

      const knownDbChatIds = new Set(users.map((u) => u.chatId));

      for (const u of users) {
        const fb = this.userSettingsFallback.get(u.chatId);
        const nweTfs = (u.nweTimeframes as SmcTimeframe[]) || ['M5', 'M15', 'H1', 'H4'];
        const smcTfs = (u.smcTimeframes as SmcTimeframe[]) || ['M5', 'M15', 'H1', 'H4'];
        const settings: UserSmcSettings = {
          nweAlertEnabled: fb !== undefined ? fb.nweAlertEnabled : (u.nweAlertEnabled ?? true),
          nweTimeframes: fb?.nweTimeframes || nweTfs,
          smcAlertEnabled: fb !== undefined ? fb.smcAlertEnabled : (u.smcAlertEnabled ?? true),
          smcTimeframes: fb?.smcTimeframes || smcTfs,
          timeframes: fb?.smcTimeframes || smcTfs,
          tier2AlertEnabled: fb?.tier2AlertEnabled !== undefined ? fb.tier2AlertEnabled : (u.tier2AlertEnabled ?? true),
        };
        result.push({ chatId: u.chatId, settings });
      }

      // CHỈ thêm activeChatIds nếu user đó CHƯA TỒN TẠI trong database (user mới tinh)
      for (const chatId of this.activeChatIds) {
        if (!knownDbChatIds.has(chatId)) {
          const settings = await this.getUserSettings(chatId);
          result.push({ chatId, settings });
        }
      }

      return result;
    } catch (e) {}

    // Fallback khi DB lỗi
    for (const chatId of this.activeChatIds) {
      const settings = await this.getUserSettings(chatId);
      result.push({ chatId, settings });
    }

    return result;
  }

  /**
   * Gửi tin nhắn Telegram song song theo batch (25 users/lượt) dùng Promise.allSettled()
   * để giảm độ trễ và log rõ chatId lỗi.
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
          this.logger.warn(`Lỗi gửi SMC/NWE alert tới chatId=${failedChatId}: ${reasonMsg}`);
        }
      });
    }

    return sentCount;
  }

  /**
   * VÒNG QUÉT HỢP LƯU CHÉO KHUNG (MTF):
   * - Tier 2 (MTF Confluence): Chạm biên NWE H1 + giao cắt >= 1 OB từ M15, M30, H1, H4
   * - Tier 3 (VIP): Thỏa Tier 2 + xuất hiện nến rút râu từ chối khung M15 (detectZoneRejectionWick + atrM15)
   */
  async checkMtfNweH1ObAlert(): Promise<{ mtfActive: boolean; triggered: boolean }> {
    try {
      const now = Date.now();
      const [m15Candles, m30Candles, h1Candles, h4Candles] = await Promise.all([
        this.fetchCandles('M15', 500),
        this.fetchCandles('M30', 500),
        this.fetchCandles('H1', 500),
        this.fetchCandles('H4', 500),
      ]);

      if (!m15Candles.length || !h1Candles.length) {
        return { mtfActive: false, triggered: false };
      }

      const nweH1 = this.calculateNwe(h1Candles, 8, 3.0);
      const atrM15 = calculateWilderAtr(m15Candles, 14);

      const obM15 = this.detectOrderBlocks(m15Candles, 'M15');
      const obM30 = this.detectOrderBlocks(m30Candles, 'M30');
      const obH1 = this.detectOrderBlocks(h1Candles, 'H1');
      const obH4 = this.detectOrderBlocks(h4Candles, 'H4');

      const obPools: OrderBlock[] = [
        ...obM15.activeSupply,
        ...obM15.activeDemand,
        ...obM30.activeSupply,
        ...obM30.activeDemand,
        ...obH1.activeSupply,
        ...obH1.activeDemand,
        ...obH4.activeSupply,
        ...obH4.activeDemand,
      ];

      const m15Candle = m15Candles[m15Candles.length - 1];
      const m15PrevCandle = m15Candles.length >= 2 ? m15Candles[m15Candles.length - 2] : undefined;
      const candleTime = normalizeCandleTimeMs(m15Candle.time);

      let result = classifySmcMtfTier({
        currentPrice: m15Candle.close,
        candleHigh: m15Candle.high,
        candleLow: m15Candle.low,
        nweH1,
        obPools,
        atrM15,
        m15Candle,
        m15PrevCandle,
        nowMs: now,
        candleDurationMs: M15_DURATION_MS,
      });

      // Chống bắn trùng cho tín hiệu nến rút râu M15 (Tier 3)
      if (
        result.tierReason === 'SMC_TIER_3_MTF_WICK' &&
        result.rejectionCandleTime !== undefined &&
        result.rejectionCandleTime <= this.lastMtfWickCandleTime &&
        result.alertTier <= this.lastMtfWickTier
      ) {
        if (result.rejectionCandleTime < candleTime) {
          // Tier 3 đến từ m15PrevCandle đã báo rồi -> đánh giá lại nến M15 hiện tại không dùng prevCandle
          result = classifySmcMtfTier({
            currentPrice: m15Candle.close,
            candleHigh: m15Candle.high,
            candleLow: m15Candle.low,
            nweH1,
            obPools,
            atrM15,
            nowMs: now,
            candleDurationMs: M15_DURATION_MS,
          });
        } else {
          return { mtfActive: true, triggered: false };
        }
      }

      if (result.signal === 'NORMAL' || !result.primaryOb || !result.direction) {
        if (this.lastMtfSignal !== 'NORMAL' && now - this.lastMtfAlertTime > 180 * 1000) {
          this.lastMtfSignal = 'NORMAL';
          this.lastMtfTier = 0;
        }
        return { mtfActive: false, triggered: false };
      }

      const isNewCandle = candleTime > this.lastMtfAlertCandleTime;
      const isUpgradeTier = result.alertTier > this.lastMtfTier;
      const isNewSignal = result.signal !== this.lastMtfSignal;
      const isNewWickConfirmation =
        result.tierReason === 'SMC_TIER_3_MTF_WICK' &&
        result.rejectionCandleTime !== undefined &&
        result.rejectionCandleTime > this.lastMtfWickCandleTime;
      const isCooldownPassed = now - this.lastMtfAlertTime > 150 * 1000;

      if (isUpgradeTier || isNewWickConfirmation || isNewCandle || isNewSignal || isCooldownPassed) {
        this.lastMtfSignal = result.signal;
        this.lastMtfTier = result.alertTier as 2 | 3;
        this.lastMtfAlertTime = now;
        this.lastMtfAlertCandleTime = candleTime;

        if (result.tierReason === 'SMC_TIER_3_MTF_WICK' && result.rejectionCandleTime !== undefined) {
          this.lastMtfWickCandleTime = result.rejectionCandleTime;
          this.lastMtfWickTier = result.alertTier;
        }

        const payload: SmcMtfAlertPayload = {
          symbol: 'XAU',
          displaySymbol:
            this.lastDataSource === 'TVC:GOLD'
              ? 'XAU/USD (Vàng Forex - TVC:GOLD)'
              : 'XAU/USD (Vàng Forex - Binance)',
          currentPrice: Number(m15Candle.close.toFixed(2)),
          nweH1,
          matchedOrderBlocks: result.matchedOrderBlocks,
          primaryOb: result.primaryOb,
          confluenceLevel: result.confluenceLevel ?? nweH1.upperBand,
          atrM15: Number(atrM15.toFixed(2)),
          signal: result.signal,
          direction: result.direction,
          alertTier: result.alertTier as 2 | 3,
          tierReason: result.tierReason,
          signalReason: result.signalReason,
          rejectionCandleTime: result.rejectionCandleTime,
          updatedAt: new Date(),
        };

        const subscribers = await this.getAllSubscribers();
        const isTier3 = payload.alertTier === 3;
        const matchedObTfs = new Set(payload.matchedOrderBlocks.map((ob) => ob.timeframe));

        const eligibleChatIds = subscribers
          .filter((sub) => {
            if (isTier3) {
              // TIER 3 (VIP): gửi cho mọi user không chủ động tắt Tier VIP
              return sub.settings.tier2AlertEnabled !== false;
            }
            // TIER 2 (MTF Confluence): gửi cho user đang bật NWE H1 hoặc OB thuộc các khung bị chạm
            const nweTfs = sub.settings.nweTimeframes || sub.settings.timeframes;
            const obTfs = sub.settings.smcTimeframes || sub.settings.timeframes;
            const matchNweH1 = sub.settings.nweAlertEnabled && nweTfs.includes('H1');
            const matchAnyOb =
              sub.settings.smcAlertEnabled &&
              obTfs.some((tf) => matchedObTfs.has(tf) && SMC_MTF_OB_TIMEFRAMES.includes(tf));
            return matchNweH1 || matchAnyOb;
          })
          .map((sub) => sub.chatId);

        if (eligibleChatIds.length === 0) {
          return { mtfActive: true, triggered: false };
        }

        const alertMsg = this.renderMtfAlertMessage(payload);
        const sentCount = await this.broadcastTelegramInBatches(
          eligibleChatIds,
          alertMsg,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🌊 Xem NWE H1', callback_data: 'nwe_view:H1' },
                  { text: `🧱 Xem OB ${payload.primaryOb.timeframe}`, callback_data: `ob_view:${payload.primaryOb.timeframe}` },
                ],
              ],
            },
          },
          25,
        );

        if (sentCount > 0) {
          const tierLabel = isTier3 ? 'TIER 3 (MTF + RÚT RÂU M15 🔥🔥🔥)' : 'TIER 2 (MTF NWE H1 + OB 🔥🔥)';
          this.logger.log(
            `🔔 [SMC/NWE ${tierLabel}] ${payload.signal} tại $${payload.currentPrice} (OB: ${Array.from(matchedObTfs).join('+')}) -> Đã gửi ${sentCount} user.`,
          );

            // SEND-FIRST, LOG-LATER: ghi DB bất đồng bộ, không chặn SSS/CallMeBot
            void (async () => {
            try {
              await this.prisma.executeWithRetry(() =>
                this.prisma.smcAlertLog.create({
                  data: {
                    symbol: 'XAU',
                    timeframe: 'MTF_H1',
                    alertType: payload.signal,
                    price: payload.currentPrice,
                    zoneTop: payload.primaryOb.top,
                    zoneBottom: payload.primaryOb.bottom,
                    message: payload.signalReason,
                  },
                }),
              );
            } catch (e: any) {
              this.logger.warn(`Ghi SmcAlertLog (MTF) thất bại (bỏ qua): ${e?.message}`);
            }
            })();

            // Báo cáo sự kiện Tier 3 sang SuperTierService để đánh giá Siêu Hợp Lưu TIER SSS
            // Nếu TIER SSS vừa kích hoạt, SuperTierService đã gọi CallMeBot mức cao nhất -> không gọi trùng SMC Tier 3
            if (isTier3) {
              const smcSlBuffer = Number((0.5 * payload.atrM15).toFixed(2));
              const smcSl =
                payload.direction === 'SELL'
                  ? Number((payload.primaryOb.top + smcSlBuffer).toFixed(2))
                  : Number((payload.primaryOb.bottom - smcSlBuffer).toFixed(2));

              let sssTriggered = false;
              if (this.superTierService) {
                try {
                  sssTriggered = await this.superTierService.reportTier3Event({
                    source: 'SMC_NWE',
                    direction: payload.direction,
                    triggeredAtMs: now,
                    candleTimeMs: payload.rejectionCandleTime ?? candleTime,
                    currentPrice: payload.currentPrice,
                    slPrice: smcSl,
                    tp1Price: payload.nweH1.kernel,
                    tp2Price: payload.nweH1.kernel,
                    summary: payload.signalReason,
                    details: {
                      nweH1: payload.nweH1,
                      primaryOb: payload.primaryOb,
                      matchedOrderBlocks: payload.matchedOrderBlocks,
                      confluenceLevel: payload.confluenceLevel,
                      atrM15: payload.atrM15,
                    },
                  });
                } catch (err: any) {
                  this.logger.warn(`Lỗi báo cáo SMC Tier 3 sang SuperTierService: ${err.message}`);
                }
              }

              // Nếu chưa đạt TIER SSS -> gọi điện CallMeBot cho SMC/NWE Tier 3
              if (!sssTriggered && this.callMeBotService) {
                const tfList = Array.from(matchedObTfs).join(' ');
                this.callMeBotService
                  .triggerVoiceCall({
                    reason: 'SMC_TIER_3',
                    direction: payload.direction,
                    price: payload.currentPrice,
                    slPrice: smcSl,
                    detailText: `khung ${tfList}`,
                  })
                  .catch((err) => {
                    this.logger.warn(`Lỗi kích hoạt CallMeBot SMC Tier 3: ${err.message}`);
                  });
              }
            }

            return { mtfActive: true, triggered: true };
        }
      }

      return { mtfActive: true, triggered: false };
    } catch (err: any) {
      this.logger.debug(`Lỗi quét SMC MTF NWE H1 + OB: ${err.message}`);
      return { mtfActive: false, triggered: false };
    }
  }

  /**
   * VÒNG LẶP QUÉT TỰ ĐỘNG KIỂM TRA CẢNH BÁO NWE & SMC TRÊN TẤT CẢ CÁC KHUNG THỜI GIAN
   * Bao gồm cả Hợp lưu Chéo Khung (NWE H1 + OB M15/M30/H1/H4 -> Tier 2 & Tier 3 Rút râu M15)
   */
  async checkAllSmcAlerts(): Promise<number> {
    if (this.isCheckingSmc) {
      return 0;
    }
    this.isCheckingSmc = true;

    try {
      let triggeredCount = 0;
      const now = Date.now();

      // 1. Chạy luồng Hợp lưu Chéo Khung (Tier 2 MTF & Tier 3 VIP Rút râu M15) trước
      const mtfStatus = await this.checkMtfNweH1ObAlert();
      if (mtfStatus.triggered) {
        triggeredCount++;
      }

      // 2. Quét từng khung đơn lẻ (Tier 1)
      for (const tf of this.supportedTimeframes) {
        try {
          const analysis = await this.analyzeTimeframe(tf);
          if (analysis.signal === 'NORMAL') {
            // Reset state nếu giá đã rời khỏi vùng
            if (this.tfAlertStateMap.has(tf)) {
              const st = this.tfAlertStateMap.get(tf)!;
              if (st.lastSignal !== 'NORMAL' && now - st.lastAlertTime > 180 * 1000) {
                st.lastSignal = 'NORMAL';
                st.lastTier = 1;
              }
            }
            continue;
          }

          // CHỐNG BẮN TRÙNG: H1 đã nằm trong luồng MTF OB (M15, M30, H1, H4).
          // Khi NWE H1 + OB H1 hợp lưu (CONFLUENCE_SELL / CONFLUENCE_BUY), bỏ qua tin nhắn đơn khung H1 cũ
          // vì đã được luồng MTF Tier 2 / Tier 3 xử lý trọn vẹn.
          if (
            tf === 'H1' &&
            (analysis.signal === 'CONFLUENCE_SELL' || analysis.signal === 'CONFLUENCE_BUY')
          ) {
            continue;
          }

          const stateKey = tf;
          const state = this.tfAlertStateMap.get(stateKey) || {
            lastSignal: 'NORMAL',
            lastAlertTime: 0,
            lastPrice: 0,
            lastTier: 1 as 1 | 2 | 3,
          };

          const isNewSignal = state.lastSignal !== analysis.signal;
          const isCooldownPassed = now - state.lastAlertTime > 150 * 1000; // Cooldown 2.5 phút

          if (isNewSignal || isCooldownPassed) {
            state.lastSignal = analysis.signal;
            state.lastAlertTime = now;
            state.lastPrice = analysis.currentPrice;
            state.lastTier = analysis.alertTier || 1;
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

            const eligibleChatIds = subscribers
              .filter((sub) => {
                const nweActive =
                  sub.settings.nweAlertEnabled &&
                  (sub.settings.nweTimeframes || sub.settings.timeframes).includes(tf);
                const obActive =
                  sub.settings.smcAlertEnabled &&
                  (sub.settings.smcTimeframes || sub.settings.timeframes).includes(tf);

                const matchNwe = isNweSignal && nweActive;
                const matchOb = isObSignal && obActive;
                return matchNwe || matchOb;
              })
              .map((sub) => sub.chatId);

            if (eligibleChatIds.length === 0) continue;

            // Tạo các nút điều hướng theo từng chiến lược riêng biệt
            const alertButtons: any[] = [];
            if (isObSignal && !isNweSignal) {
              alertButtons.push([
                { text: `📊 Xem Order Block ${tf}`, callback_data: `ob_view:${tf}` },
                { text: '⚙️ Bảng Order Block', callback_data: 'ob_settings' },
              ]);
            } else if (isNweSignal && !isObSignal) {
              alertButtons.push([
                { text: `📊 Xem NWE ${tf}`, callback_data: `nwe_view:${tf}` },
                { text: '⚙️ Bảng NWE', callback_data: 'nwe_settings' },
              ]);
            } else {
              alertButtons.push([
                { text: `🌊 Xem NWE ${tf}`, callback_data: `nwe_view:${tf}` },
                { text: `🧱 Xem OB ${tf}`, callback_data: `ob_view:${tf}` },
              ]);
            }

            const sentCount = await this.broadcastTelegramInBatches(
              eligibleChatIds,
              alertMsg,
              {
                reply_markup: {
                  inline_keyboard: alertButtons,
                },
              },
              25,
            );

            if (sentCount > 0) {
              triggeredCount++;
              this.logger.log(
                `🔔 [SMC/NWE ALERT TIER 1] Khung ${tf}: ${analysis.signal} tại $${analysis.currentPrice} -> Đã gửi ${sentCount} user.`,
              );

              // Ghi log vào DB
              void (async () => {
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
              } catch (e: any) {
                this.logger.warn(`Ghi SmcAlertLog (Tier 1) thất bại (bỏ qua): ${e?.message}`);
              }
              })();
            }
          }
        } catch (err: any) {
          this.logger.debug(`Lỗi quét SMC khung ${tf}: ${err.message}`);
        }
      }

      return triggeredCount;
    } finally {
      this.isCheckingSmc = false;
    }
  }

  /**
   * FORMAT BẢNG DASHBOARD RIÊNG CHO NADARAYA-WATSON ENVELOPE (NWE)
   */
  renderNweDashboard(
    analysis: SmcAnalysisResult,
    isNweOn: boolean,
    nweTfs: SmcTimeframe[],
    isTier2On = true,
  ): string {
    const nowStr = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date());

    const nwe = analysis.nwe;
    const currentPrice = analysis.currentPrice;
    const distToUpper = nwe.upperBand - currentPrice;
    const distToLower = currentPrice - nwe.lowerBand;
    const distUpStr = distToUpper > 0 ? `(Cách +$${distToUpper.toFixed(2)})` : `(ĐÃ CHẠM/VƯỢT)`;
    const distDownStr = distToLower > 0 ? `(Cách -$${distToLower.toFixed(2)})` : `(ĐÃ CHẠM/THỦNG)`;

    let statusText = '⚪ VÙNG TRUNG TÍNH (Dao động an toàn bên trong dải)';
    if (nwe.isTouchUpper) {
      statusText = '🔴 ĐANG CHẠM DẢI TRÊN (Vùng Quá Mua / Kháng cự cực hạn)';
    } else if (nwe.isTouchLower) {
      statusText = '🟢 ĐANG CHẠM DẢI DƯỚI (Vùng Quá Bán / Hỗ trợ cực hạn)';
    }

    let msg = `🌊 <b>CHIẾN LƯỢC: NADARAYA-WATSON ENVELOPE (NWE + DYNAMIC S/R)</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💎 <b>Tài sản:</b> <code>${analysis.displaySymbol}</code>\n`;
    msg += `⏳ <b>Khung thời gian:</b> <b>${this.timeframeLabels[analysis.timeframe] || analysis.timeframe}</b>\n`;
    msg += `💰 <b>Giá hiện tại:</b> <code>$${currentPrice.toFixed(2)}</code>\n`;
    msg += `🕒 <i>Cập nhật: ${nowStr}</i>\n\n`;

    msg += `📈 <b>THÔNG SỐ DẢI ENVELOPE & CẢN ĐỘNG (h=8, mult=3):</b>\n`;
    msg += `• 🔴 <b>Dải trên (Upper Band):</b> <code>$${nwe.upperBand.toFixed(2)}</code> ${distUpStr}\n`;
    msg += `• ⚪ <b>Kernel trung tâm:</b> <code>$${nwe.kernel.toFixed(2)}</code>\n`;
    msg += `• 🟢 <b>Dải dưới (Lower Band):</b> <code>$${nwe.lowerBand.toFixed(2)}</code> ${distDownStr}\n`;
    msg += `• 🛡 <b>Kháng cự động:</b> <code>$${nwe.dynamicResistance.toFixed(2)}</code>\n`;
    msg += `• 🛡 <b>Hỗ trợ động:</b> <code>$${nwe.dynamicSupport.toFixed(2)}</code>\n\n`;

    msg += `⚡ <b>Trạng thái:</b> <b>${statusText}</b>\n`;
    msg += `🔔 <b>Cảnh báo tự động NWE:</b> <b>${isNweOn ? '🟢 ĐANG BẬT' : '⚪ ĐÃ TẮT'}</b>\n`;
    msg += `⏳ <b>Khung nhận tin NWE (${nweTfs.length}/6 khung):</b> <code>${nweTfs.join(', ')}</code>\n`;
    msg += `🔥 <b>Cảnh báo Tier 3 VIP (NWE H1 + OB + Rút râu M15):</b> <b>${isTier2On ? '🟢 ĐANG BẬT (Ưu tiên cao nhất)' : '⚪ ĐÃ TẮT'}</b>\n`;

    return msg;
  }

  /**
   * FORMAT BẢNG DASHBOARD RIÊNG CHO ORDER BLOCK (SMC - CUNG & CẦU)
   */
  renderObDashboard(
    analysis: SmcAnalysisResult,
    isObOn: boolean,
    obTfs: SmcTimeframe[],
    isTier2On = true,
  ): string {
    const nowStr = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date());

    let statusText = '⚪ VÙNG TRUNG TÍNH (Chưa chạm Order Block)';
    if (analysis.touchingSupply) {
      statusText = `🔴 ĐÃ CHẠM VÙNG CUNG (${analysis.touchingSupply.label}) [$${analysis.touchingSupply.bottom} - $${analysis.touchingSupply.top}]`;
    } else if (analysis.touchingDemand) {
      statusText = `🟢 ĐÃ CHẠM VÙNG CẦU (${analysis.touchingDemand.label}) [$${analysis.touchingDemand.bottom} - $${analysis.touchingDemand.top}]`;
    }

    let msg = `🧱 <b>CHIẾN LƯỢC: SMC ORDER BLOCKS (VÙNG CUNG / CẦU)</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💎 <b>Tài sản:</b> <code>${analysis.displaySymbol}</code>\n`;
    msg += `⏳ <b>Khung thời gian:</b> <b>${this.timeframeLabels[analysis.timeframe] || analysis.timeframe}</b>\n`;
    msg += `💰 <b>Giá hiện tại:</b> <code>$${analysis.currentPrice.toFixed(2)}</code>\n`;
    msg += `🕒 <i>Cập nhật: ${nowStr}</i>\n\n`;

    msg += `📦 <b>CÁC VÙNG CUNG - CẦU (ORDER BLOCKS) CÒN HIỆU LỰC:</b>\n`;
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

    msg += `⚡ <b>Trạng thái:</b> <b>${statusText}</b>\n`;
    msg += `🔔 <b>Cảnh báo tự động Order Block:</b> <b>${isObOn ? '🟢 ĐANG BẬT' : '⚪ ĐÃ TẮT'}</b>\n`;
    msg += `⏳ <b>Khung nhận tin Order Block (${obTfs.length}/6 khung):</b> <code>${obTfs.join(', ')}</code>\n`;
    msg += `🔥 <b>Cảnh báo Tier 3 VIP (NWE H1 + OB + Rút râu M15):</b> <b>${isTier2On ? '🟢 ĐANG BẬT (Ưu tiên cao nhất)' : '⚪ ĐÃ TẮT'}</b>\n`;

    return msg;
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

    return msg;
  }

  /**
   * FORMAT TIN NHẮN CẢNH BÁO HỢP LƯU CHÉO KHUNG (SMC + NWE TIER 2 & TIER 3 VIP)
   * Tối ưu tốc độ vào lệnh (< 2 giây đọc, 1 chạm copy giá dán MT5)
   */
  renderMtfAlertMessage(payload: SmcMtfAlertPayload): string {
    const nowStr = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date());

    const isSell = payload.direction === 'SELL';
    const isTier3 = payload.alertTier === 3;
    const tfSummary = Array.from(new Set(payload.matchedOrderBlocks.map((ob) => ob.timeframe))).join('+');
    const shortSym = (payload.displaySymbol || 'XAU/USD').split(' (')[0].trim() || 'XAU/USD';

    const primaryOb = payload.primaryOb;
    const slBuffer = Number((0.5 * payload.atrM15).toFixed(2));
    const suggestedSl = isSell
      ? Number((primaryOb.top + slBuffer).toFixed(2))
      : Number((primaryOb.bottom - slBuffer).toFixed(2));

    const entryPrice = payload.confluenceLevel;
    const slDist = Math.abs(entryPrice - suggestedSl);
    const kernelPrice = payload.nweH1.kernel;
    const kernelProfit = isSell ? entryPrice - kernelPrice : kernelPrice - entryPrice;
    const rr2Price = isSell
      ? Number((entryPrice - 2 * slDist).toFixed(2))
      : Number((entryPrice + 2 * slDist).toFixed(2));
    const rr15Price = isSell
      ? Number((entryPrice - 1.5 * slDist).toFixed(2))
      : Number((entryPrice + 1.5 * slDist).toFixed(2));

    // Sắp xếp TP1 (gần hơn) -> TP2 (xa hơn) để không bị ngược TP1 > TP2 khi NWE H1 Kernel xa hơn 2R
    let tp1Price: number;
    let tp1Label: string;
    let tp2Price: number;
    let tp2Label: string;

    if (kernelProfit > 0 && kernelProfit < 2 * slDist) {
      tp1Price = kernelPrice;
      tp1Label = 'NWE H1 Kernel';
      tp2Price = rr2Price;
      tp2Label = 'R:R 1:2';
    } else if (kernelProfit >= 2 * slDist) {
      tp1Price = rr15Price;
      tp1Label = 'R:R 1:1.5';
      tp2Price = kernelPrice;
      tp2Label = 'NWE H1 Kernel';
    } else {
      tp1Price = rr15Price;
      tp1Label = 'R:R 1:1.5';
      tp2Price = rr2Price;
      tp2Label = 'R:R 1:2';
    }

    const tp1Diff = isSell ? entryPrice - tp1Price : tp1Price - entryPrice;
    const tp1Sign = tp1Diff >= 0 ? '+' : '-';
    const tp1RR = slDist > 0 ? (Math.abs(tp1Diff) / slDist).toFixed(1) : '0.0';

    const tp2Diff = isSell ? entryPrice - tp2Price : tp2Price - entryPrice;
    const tp2Sign = tp2Diff >= 0 ? '+' : '-';
    const tp2RR = slDist > 0 ? (Math.abs(tp2Diff) / slDist).toFixed(1) : '0.0';

    const mktDiff = payload.currentPrice - entryPrice;
    const mktSign = mktDiff >= 0 ? '+' : '-';

    const dirDot = isSell ? '🔴🔴' : '🟢🟢';
    const dirAction = isSell ? 'SELL' : 'BUY';
    const tierBadge = isTier3 ? '🔥🔥🔥 <b>SMC TIER 3 VIP</b>' : '🔥🔥 <b>SMC TIER 2 MTF</b>';

    let obLines = '';
    payload.matchedOrderBlocks.forEach((ob) => {
      const icon = ob.type === 'SUPPLY' ? '🔴' : '🟢';
      const star = ob.id === primaryOb.id ? ' ⭐' : '';
      obLines += `• ${icon} <b>${ob.timeframe}${star}:</b> <code>${ob.bottom.toFixed(2)}</code> – <code>${ob.top.toFixed(2)}</code>\n`;
    });

    const nweEdge = isSell ? payload.nweH1.upperBand : payload.nweH1.lowerBand;

    const tp1Suffix = tp1Label.startsWith('R:R') ? tp1Label : `${tp1Label} · 1:${tp1RR}`;
    const tp2Suffix = tp2Label.startsWith('R:R') ? tp2Label : `${tp2Label} · 1:${tp2RR}`;

    let msg = `${dirDot} <b>${dirAction} ${shortSym}</b> • ${tierBadge}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🎯 <b>ENTRY:</b> <code>${entryPrice.toFixed(2)}</code> <i>(NWE H1 + OB ${primaryOb.timeframe})</i>\n`;
    msg += `🛑 <b>SL:</b> <code>${suggestedSl.toFixed(2)}</code> <b>(-${slDist.toFixed(2)})</b> <i>· Ngoài OB + 0.5 ATR</i>\n`;
    msg += `✅ <b>TP1:</b> <code>${tp1Price.toFixed(2)}</code> <i>(${tp1Sign}${Math.abs(tp1Diff).toFixed(2)} · ${tp1Suffix})</i>\n`;
    msg += `✅ <b>TP2:</b> <code>${tp2Price.toFixed(2)}</code> <i>(${tp2Sign}${Math.abs(tp2Diff).toFixed(2)} · ${tp2Suffix})</i>\n`;
    msg += `💵 <b>Giá MKT:</b> <code>${payload.currentPrice.toFixed(2)}</code> <i>(${mktSign}${Math.abs(mktDiff).toFixed(2)} vs Entry)</i>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;

    msg += `📌 <b>Hợp lưu:</b> NWE H1 (<code>${nweEdge.toFixed(2)}</code>) + OB <b>${tfSummary}</b>${isTier3 ? ' + <b>Rút râu M15</b>' : ''}\n`;
    msg += `🧱 <b>Khối OB (${payload.matchedOrderBlocks.length}):</b>\n${obLines}`;
    msg += `📐 <b>ATR M15:</b> <code>${payload.atrM15.toFixed(2)}</code> · 🕒 <code>${nowStr}</code>`;

    return msg;
  }

  /**
   * FORMAT TIN NHẮN CẢNH BÁO GỬI TELEGRAM KHI CHẠM NWE HOẶC ORDER BLOCK (TIER 1 ĐƠN KHUNG)
   */
  renderAlertMessage(analysis: SmcAnalysisResult): string {
    const nowStr = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date());

    const shortSym = (analysis.displaySymbol || 'XAU/USD').split(' (')[0].trim() || 'XAU/USD';
    const isSell =
      analysis.signal === 'CONFLUENCE_SELL' ||
      analysis.signal === 'TOUCH_SUPPLY_OB' ||
      analysis.signal === 'TOUCH_NWE_UPPER';
    const isConfluence =
      analysis.signal === 'CONFLUENCE_SELL' || analysis.signal === 'CONFLUENCE_BUY';

    const dirAction = isSell ? 'SELL' : 'BUY';
    const dirDot = isConfluence ? (isSell ? '🚨🔴🔴' : '🚨🟢🟢') : isSell ? '🔴' : '🟢';

    let badge = `SMC/NWE (${analysis.timeframe})`;
    if (isConfluence) badge = `HỢP LƯU NWE + OB (${analysis.timeframe})`;
    else if (analysis.signal === 'TOUCH_SUPPLY_OB') badge = `SUPPLY OB (${analysis.timeframe})`;
    else if (analysis.signal === 'TOUCH_DEMAND_OB') badge = `DEMAND OB (${analysis.timeframe})`;
    else if (analysis.signal === 'TOUCH_NWE_UPPER') badge = `NWE UPPER (${analysis.timeframe})`;
    else if (analysis.signal === 'TOUCH_NWE_LOWER') badge = `NWE LOWER (${analysis.timeframe})`;

    const activeOb = isSell ? analysis.touchingSupply : analysis.touchingDemand;
    const nweEdge = isSell ? analysis.nwe.upperBand : analysis.nwe.lowerBand;
    const tpKernel = analysis.nwe.kernel;

    let msg = `${dirDot} <b>CANH ${dirAction} ${shortSym}</b> • <b>${badge}</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💵 <b>Giá MKT:</b> <code>${analysis.currentPrice.toFixed(2)}</code>\n`;
    if (activeOb) {
      msg += `🧱 <b>Vùng OB:</b> <code>${activeOb.bottom.toFixed(2)}</code> – <code>${activeOb.top.toFixed(2)}</code>\n`;
      const obEdgeSl = isSell ? activeOb.top : activeOb.bottom;
      msg += `🛑 <b>Mép ngoài OB (SL ref):</b> <code>${obEdgeSl.toFixed(2)}</code>\n`;
    }
    msg += `🌊 <b>Biên NWE ${isSell ? 'Upper' : 'Lower'}:</b> <code>${nweEdge.toFixed(2)}</code>\n`;
    msg += `✅ <b>TP1 (Kernel):</b> <code>${tpKernel.toFixed(2)}</code>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📌 ${analysis.signalReason}\n`;
    msg += `🕒 <code>${nowStr}</code>`;

    return msg;
  }
}
