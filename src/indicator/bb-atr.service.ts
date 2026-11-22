import { Injectable, Logger, Inject, forwardRef, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
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
import { LiquiditySweepService, SweepSignal } from '../services/liquiditySweep';

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
  private isWsConnecting = false;

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

  // Quản lý trạng thái Global Auto-Scanner cho XAU/USD M5 để chống spam tin nhắn
  private lastGlobalSignal: BbAtrSignalType = 'NORMAL';
  private lastGlobalAlertTime = 0;
  private lastGlobalAlertPrice = 0;
  private lastAlertTier = 0;
  private scanTickCount = 0;

  // Cache cấu hình người dùng phòng trường hợp DB chưa migrate cột mới
  private readonly userSettingFallback = new Map<string, boolean>();
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
    private readonly liquiditySweepService: LiquiditySweepService,
  ) {}

  onModuleInit() {
    this.initTradingViewLiveStream();
  }

  onModuleDestroy() {
    this.stopTradingViewLiveStream();
  }

  /**
   * Khởi chạy luồng WebSocket thời gian thực kết nối trực tiếp TradingView OANDA:XAUUSD
   * Cập nhật từng tick theo mili-giây (0ms delay), loại bỏ hoàn toàn độ trễ 1-2 phút của Scanner
   */
  private initTradingViewLiveStream() {
    if (this.isWsConnecting || this.isWsConnected) return;
    this.isWsConnecting = true;

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const WebSocket = require('ws');
      this.liveWs = new WebSocket('wss://data.tradingview.com/socket.io/websocket', {
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

      const chartSession = 'cs_' + Math.random().toString(36).substring(2, 12);

      this.liveWs.on('open', () => {
        this.logger.log('🟢 [Live WebSocket] Đã kết nối luồng giá thời gian thực TradingView OANDA:XAUUSD (0ms latency)!');
        this.isWsConnected = true;
        this.isWsConnecting = false;

        this.liveWs.send(createMsg('set_auth_token', ['unauthorized_user_token']));
        this.liveWs.send(createMsg('chart_create_session', [chartSession, '']));
        this.liveWs.send(
          createMsg('resolve_symbol', [chartSession, 'sds_sym_1', '={"symbol":"OANDA:XAUUSD","adjustment":"splits"}']),
        );
        this.liveWs.send(createMsg('create_series', [chartSession, 'sds_1', 's1', 'sds_sym_1', '5', 150, '']));
      });

      this.liveWs.on('message', (data: any) => {
        const raw = data.toString();
        const packets = raw.split(/~m~\d+~m~/).filter(Boolean);
        for (const packet of packets) {
          if (packet.startsWith('~h~')) {
            if (this.liveWs && this.liveWs.readyState === 1) {
              this.liveWs.send('~m~' + packet.length + '~m~' + packet);
            }
            continue;
          }
          try {
            const msg = JSON.parse(packet);
            if (msg.m === 'timescale_update' || msg.m === 'du') {
              const sds = msg.p[1]?.sds_1;
              if (sds && sds.s && Array.isArray(sds.s)) {
                this.handleLiveCandlesUpdate(sds.s);
              }
            }
          } catch (e) {}
        }
      });

      this.liveWs.on('close', () => {
        this.isWsConnected = false;
        this.isWsConnecting = false;
        this.scheduleWsReconnect();
      });

      this.liveWs.on('error', (err: any) => {
        this.logger.warn(`⚠️ [Live WebSocket] Mất kết nối: ${err.message}. Đang thử kết nối lại...`);
        this.isWsConnected = false;
        this.isWsConnecting = false;
        this.scheduleWsReconnect();
      });
    } catch (err: any) {
      this.logger.error(`Không thể kết nối WebSocket TradingView: ${err.message}`);
      this.isWsConnecting = false;
      this.scheduleWsReconnect();
    }
  }

  private scheduleWsReconnect() {
    if (this.wsReconnectTimer) return;
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      this.initTradingViewLiveStream();
    }, 3000);
  }

  private stopTradingViewLiveStream() {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.liveWs) {
      try {
        this.liveWs.close();
      } catch (e) {}
      this.liveWs = null;
    }
    this.isWsConnected = false;
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

      const upperEntry = bb.upper + atr;
      const lowerEntry = bb.lower - atr;
      const last = this.liveCandles[this.liveCandles.length - 1];
      const price = last.close;
      const high = last.high;
      const low = last.low;

      const isTouchUpper = price >= bb.upper || high >= bb.upper;
      const isTouchLower = price <= bb.lower || low <= bb.lower;
      const isRsiOverbought = rsi >= 70;
      const isRsiOversold = rsi <= 30;

      const isEntrySell = price >= upperEntry || high >= upperEntry;
      const isEntryBuy = price <= lowerEntry || low <= lowerEntry;

      let signal: BbAtrSignalType = 'NORMAL';
      let alertTier: 0 | 1 | 2 | 3 = 0;

      // 1. Phía BÁN (Sell):
      // - Tier 1 & Tier 2: Giá bung chạm/vượt Bands Upper + ATR(14)
      if (isEntrySell) {
        signal = 'ENTRY_SELL';
        alertTier = isRsiOverbought ? 2 : 1; // 🔥🔥 Tier 2 nếu có RSI >= 70, ngược lại 🔥 Tier 1
      }
      // - Chạm dải trên BB thông thường:
      else if (isTouchUpper) {
        signal = isRsiOverbought ? 'SELL_CONFLUENCE' : 'TOUCH_UPPER_BB';
        alertTier = 0; // Chạm dải BB bình thường (không đốm lửa)
      }
      // 2. Phía MUA (Buy):
      // - Tier 1 & Tier 2: Giá đâm thủng Bands Lower - ATR(14)
      else if (isEntryBuy) {
        signal = 'ENTRY_BUY';
        alertTier = isRsiOversold ? 2 : 1; // 🔥🔥 Tier 2 nếu có RSI <= 30, ngược lại 🔥 Tier 1
      }
      // - Chạm dải dưới BB thông thường:
      else if (isTouchLower) {
        signal = isRsiOversold ? 'BUY_CONFLUENCE' : 'TOUCH_LOWER_BB';
        alertTier = 0; // Chạm dải BB bình thường (không đốm lửa)
      }

      // Kích hoạt bắn cảnh báo khi có tín hiệu chạm dải BB hoặc khớp Entry (+/- ATR)
      if (signal !== 'NORMAL') {
        const now = Date.now();
        const candleTime = last.time;
        const isNewCandle = candleTime > this.lastAlertCandleTime;
        const isUpgradeSignal = alertTier > (this.lastAlertTier || 0);
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
    if (
      isGold &&
      timeframe === 'M5' &&
      this.isWsConnected &&
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
      const currentPrice = last.close;
      const candleHigh = last.high;
      const candleLow = last.low;
      const candleTime = last.time;

      const upperEntry = bb.upper + atr;
      const lowerEntry = bb.lower - atr;
      const sellSl = upperEntry + atr;
      const buySl = lowerEntry - atr;
      const slDistance = atr;

      const distToUpper = upperEntry - currentPrice;
      const distToUpperPercent = Number(((distToUpper / currentPrice) * 100).toFixed(2));
      const distToLower = currentPrice - lowerEntry;
      const distToLowerPercent = Number(((distToLower / currentPrice) * 100).toFixed(2));

      const isTouchUpper = currentPrice >= bb.upper || candleHigh >= bb.upper;
      const isTouchLower = currentPrice <= bb.lower || candleLow <= bb.lower;
      const isRsiOverbought = rsi >= 70;
      const isRsiOversold = rsi <= 30;

      let signal: BbAtrSignalType = 'NORMAL';
      let signalReason = 'Giá đang nằm trong dải dao động an toàn.';
      let alertTier: 0 | 1 | 2 | 3 = 0;

      // 1. Phía BÁN (Sell):
      // - Cấp độ Entry gốc (Bands Upper + ATR):
      if (currentPrice >= upperEntry || candleHigh >= upperEntry) {
        signal = 'ENTRY_SELL';
        if (isRsiOverbought) {
          alertTier = 2; // 🔥🔥 TIER 2: Bands Upper + ATR + RSI >= 70
          signalReason = `🔥🔥 [TIER 2] HỢP LƯU ENTRY SELL (BB UPPER + ATR) + RSI QUÁ MUA (≥ 70)! Giá ($${currentPrice.toFixed(2)}) đã vượt mốc $${upperEntry.toFixed(2)} và RSI = ${rsi.toFixed(1)}.`;
        } else {
          alertTier = 1; // 🔥 TIER 1: Bands Upper + ATR
          signalReason = `🔥 [TIER 1] KHỚP VÙNG ENTRY SELL (BANDS UPPER + ATR)! Giá ($${currentPrice.toFixed(2)}) đã bung vượt mốc $${upperEntry.toFixed(2)} (RSI: ${rsi.toFixed(1)}).`;
        }
      }
      // - Chạm dải trên BB thông thường:
      else if (isTouchUpper) {
        if (isRsiOverbought) {
          signal = 'SELL_CONFLUENCE';
          alertTier = 0;
          signalReason = `Giá chạm dải BB trên ($${bb.upper.toFixed(2)}) và RSI = ${rsi.toFixed(1)} (≥ 70 - Quá Mua).`;
        } else {
          signal = 'TOUCH_UPPER_BB';
          alertTier = 0;
          signalReason = `Giá chạm dải BB trên ($${bb.upper.toFixed(2)}) (RSI: ${rsi.toFixed(1)}).`;
        }
      }
      // 2. Phía MUA (Buy):
      // - Cấp độ Entry gốc (Bands Lower - ATR):
      else if (currentPrice <= lowerEntry || candleLow <= lowerEntry) {
        signal = 'ENTRY_BUY';
        if (isRsiOversold) {
          alertTier = 2; // 🔥🔥 TIER 2: Bands Lower - ATR + RSI <= 30
          signalReason = `🔥🔥 [TIER 2] HỢP LƯU ENTRY BUY (BB LOWER - ATR) + RSI QUÁ BÁN (≤ 30)! Giá ($${currentPrice.toFixed(2)}) đâm thủng mốc $${lowerEntry.toFixed(2)} và RSI = ${rsi.toFixed(1)}.`;
        } else {
          alertTier = 1; // 🔥 TIER 1: Bands Lower - ATR
          signalReason = `🔥 [TIER 1] KHỚP VÙNG ENTRY BUY (BANDS LOWER - ATR)! Giá ($${currentPrice.toFixed(2)}) đã đâm thủng mốc $${lowerEntry.toFixed(2)} (RSI: ${rsi.toFixed(1)}).`;
        }
      }
      // - Chạm dải dưới BB thông thường:
      else if (isTouchLower) {
        if (isRsiOversold) {
          signal = 'BUY_CONFLUENCE';
          alertTier = 0;
          signalReason = `Giá chạm dải BB dưới ($${bb.lower.toFixed(2)}) và RSI = ${rsi.toFixed(1)} (≤ 30 - Quá Bán).`;
        } else {
          signal = 'TOUCH_LOWER_BB';
          alertTier = 0;
          signalReason = `Giá chạm dải BB dưới ($${bb.lower.toFixed(2)}) (RSI: ${rsi.toFixed(1)}).`;
        }
      }

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
        alertTier,
        rsiPeriod: 14,
        rsiValue: rsi,
        isRsiOversold,
        isRsiOverbought,
        upperEntry: Number(upperEntry.toFixed(4)),
        lowerEntry: Number(lowerEntry.toFixed(4)),
        sellSl: Number(sellSl.toFixed(4)),
        buySl: Number(buySl.toFixed(4)),
        slDistance: Number(slDistance.toFixed(4)),
        distToUpper: Number(distToUpper.toFixed(4)),
        distToUpperPercent,
        distToLower: Number(distToLower.toFixed(4)),
        distToLowerPercent,
        signal,
        signalReason,
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

        let signal: BbAtrSignalType = 'NORMAL';
        let signalReason = 'Giá đang nằm trong dải dao động an toàn.';

        if (currentPrice >= upperEntry || candleHigh >= upperEntry) {
          signal = 'ENTRY_SELL';
          signalReason = `Giá ($${currentPrice.toFixed(2)}) đã bung lên vượt dải trên thêm 1 ATR ($${upperEntry.toFixed(2)} = BB Upper + ATR). Vùng Entry Bán cực hạn!`;
        } else if (currentPrice >= bbUpper || candleHigh >= bbUpper) {
          signal = 'TOUCH_UPPER_BB';
          signalReason = `Giá ($${currentPrice.toFixed(2)}) đã chạm/vượt dải trên Bollinger Bands ($${bbUpper.toFixed(2)}).`;
        } else if (currentPrice <= lowerEntry || candleLow <= lowerEntry) {
          signal = 'ENTRY_BUY';
          signalReason = `Giá ($${currentPrice.toFixed(2)}) đã đâm thủng dải dưới thêm 1 ATR ($${lowerEntry.toFixed(2)} = BB Lower - ATR). Vùng Entry Mua cực hạn!`;
        } else if (currentPrice <= bbLower || candleLow <= bbLower) {
          signal = 'TOUCH_LOWER_BB';
          signalReason = `Giá ($${currentPrice.toFixed(2)}) đã chạm/thủng dải dưới Bollinger Bands ($${bbLower.toFixed(2)}).`;
        }

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
          upperEntry: Number(upperEntry.toFixed(4)),
          lowerEntry: Number(lowerEntry.toFixed(4)),
          sellSl: Number(sellSl.toFixed(4)),
          buySl: Number(buySl.toFixed(4)),
          slDistance: Number(slDistance.toFixed(4)),
          distToUpper: Number(distToUpper.toFixed(4)),
          distToUpperPercent,
          distToLower: Number(distToLower.toFixed(4)),
          distToLowerPercent,
          signal,
          signalReason,
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

    // Tính khoảng cách
    const distToUpper = upperEntry - currentPrice;
    const distToUpperPercent = Number(((distToUpper / currentPrice) * 100).toFixed(2));
    const distToLower = currentPrice - lowerEntry;
    const distToLowerPercent = Number(((distToLower / currentPrice) * 100).toFixed(2));

    const isTouchUpper = currentPrice >= bb.upper || lastCandle.high >= bb.upper;
    const isTouchLower = currentPrice <= bb.lower || lastCandle.low <= bb.lower;
    const isRsiOverbought = rsi >= 70;
    const isRsiOversold = rsi <= 30;

    let signal: BbAtrSignalType = 'NORMAL';
    let signalReason = 'Giá đang nằm trong dải dao động an toàn.';
    let alertTier: 0 | 1 | 2 | 3 = 0;

    // 1. Phía BÁN (Sell):
    // - Cấp độ Entry gốc (Bands Upper + ATR):
    if (currentPrice >= upperEntry || lastCandle.high >= upperEntry) {
      signal = 'ENTRY_SELL';
      if (isRsiOverbought) {
        alertTier = 2; // 🔥🔥 TIER 2: Bands Upper + ATR + RSI >= 70
        signalReason = `🔥🔥 [TIER 2] HỢP LƯU ENTRY SELL (BB UPPER + ATR) + RSI QUÁ MUA (≥ 70)! Giá ($${currentPrice.toFixed(2)}) đã bung vượt mốc $${upperEntry.toFixed(2)} và RSI = ${rsi.toFixed(1)}.`;
      } else {
        alertTier = 1; // 🔥 TIER 1: Bands Upper + ATR
        signalReason = `🔥 [TIER 1] KHỚP VÙNG ENTRY SELL (BANDS UPPER + ATR)! Giá ($${currentPrice.toFixed(2)}) đã bung vượt mốc $${upperEntry.toFixed(2)} (RSI: ${rsi.toFixed(1)}).`;
      }
    }
    // - Chạm dải trên BB thông thường:
    else if (isTouchUpper) {
      if (isRsiOverbought) {
        signal = 'SELL_CONFLUENCE';
        alertTier = 0;
        signalReason = `Giá chạm dải BB trên ($${bb.upper.toFixed(2)}) và RSI = ${rsi.toFixed(1)} (≥ 70 - Quá Mua).`;
      } else {
        signal = 'TOUCH_UPPER_BB';
        alertTier = 0;
        signalReason = `Giá chạm dải BB trên ($${bb.upper.toFixed(2)}) (RSI: ${rsi.toFixed(1)}).`;
      }
    }
    // 2. Phía MUA (Buy):
    // - Cấp độ Entry gốc (Bands Lower - ATR):
    else if (currentPrice <= lowerEntry || lastCandle.low <= lowerEntry) {
      signal = 'ENTRY_BUY';
      if (isRsiOversold) {
        alertTier = 2; // 🔥🔥 TIER 2: Bands Lower - ATR + RSI <= 30
        signalReason = `🔥🔥 [TIER 2] HỢP LƯU ENTRY BUY (BB LOWER - ATR) + RSI QUÁ BÁN (≤ 30)! Giá ($${currentPrice.toFixed(2)}) đã đâm thủng mốc $${lowerEntry.toFixed(2)} và RSI = ${rsi.toFixed(1)}.`;
      } else {
        alertTier = 1; // 🔥 TIER 1: Bands Lower - ATR
        signalReason = `🔥 [TIER 1] KHỚP VÙNG ENTRY BUY (BANDS LOWER - ATR)! Giá ($${currentPrice.toFixed(2)}) đã đâm thủng mốc $${lowerEntry.toFixed(2)} (RSI: ${rsi.toFixed(1)}).`;
      }
    }
    // - Chạm dải dưới BB thông thường:
    else if (isTouchLower) {
      if (isRsiOversold) {
        signal = 'BUY_CONFLUENCE';
        alertTier = 0;
        signalReason = `Giá chạm dải BB dưới ($${bb.lower.toFixed(2)}) và RSI = ${rsi.toFixed(1)} (≤ 30 - Quá Bán).`;
      } else {
        signal = 'TOUCH_LOWER_BB';
        alertTier = 0;
        signalReason = `Giá chạm dải BB dưới ($${bb.lower.toFixed(2)}) (RSI: ${rsi.toFixed(1)}).`;
      }
    }

    return {
      symbol: symbol.toUpperCase(),
      displaySymbol,
      assetType,
      timeframe,
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
      isRsiOversold,
      isRsiOverbought,
      alertTier,
      upperEntry: Number(upperEntry.toFixed(4)),
      lowerEntry: Number(lowerEntry.toFixed(4)),
      sellSl: Number(sellSl.toFixed(4)),
      buySl: Number(buySl.toFixed(4)),
      slDistance: Number(slDistance.toFixed(4)),
      distToUpper: Number(distToUpper.toFixed(4)),
      distToUpperPercent,
      distToLower: Number(distToLower.toFixed(4)),
      distToLowerPercent,
      signal,
      signalReason,
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
   * Lấy danh sách tất cả ChatId người dùng có bật nhận cảnh báo tự động kèm bộ lọc Bias
   * TUYỆT ĐỐI KHÔNG GỬI NẾU NGƯỜI DÙNG ĐÃ TẮT CẢNH BÁO (bbAtrAlertEnabled = false)
   */
  async getAllUsersForGlobalAlert(): Promise<Array<{ chatId: string; bias: BbAtrBias }>> {
    try {
      const allUsers = await this.prisma.executeWithRetry(() =>
        this.prisma.telegramUser.findMany({
          select: { chatId: true, bbAtrAlertEnabled: true, bbAtrBias: true },
        }),
      );

      if (allUsers && allUsers.length > 0) {
        const knownDbChatIds = new Set(allUsers.map((u) => u.chatId));
        const result: Array<{ chatId: string; bias: BbAtrBias }> = [];

        for (const u of allUsers) {
          // Trạng thái BẬT/TẮT: Kiểm tra cả Database và Fallback bộ nhớ
          // Nếu một trong hai là false thì TUYỆT ĐỐI KHÔNG GỬI
          const isFallbackOff = this.userSettingFallback.get(u.chatId) === false;
          const isDbOff = u.bbAtrAlertEnabled === false;

          if (!isDbOff && !isFallbackOff) {
            result.push({
              chatId: u.chatId,
              bias: (u.bbAtrBias && ['BOTH', 'BUY_ONLY', 'SELL_ONLY'].includes(u.bbAtrBias)
                ? (u.bbAtrBias as BbAtrBias)
                : this.userBiasFallback.get(u.chatId) || 'BOTH'),
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
    const fallbackList: Array<{ chatId: string; bias: BbAtrBias }> = [];
    for (const chatId of this.activeChatIds) {
      if (this.userSettingFallback.get(chatId) === true) {
        fallbackList.push({
          chatId,
          bias: this.userBiasFallback.get(chatId) || 'BOTH',
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
      const allUsers = await this.prisma.executeWithRetry(() =>
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
   * VÒNG LẶP GLOBAL AUTO-SCANNER: Quét liên tục XAU/USD trên khung M5
   * Tự động phát hiện khi giá chạm 2 dải BB (Upper/Lower) HOẶC chạm ngưỡng Entry mở rộng (+/- 1 ATR)
   */
  async checkGlobalXauM5Alert(): Promise<boolean> {
    try {
      const state = await this.getBbAtrState('XAU', 'M5');
      const now = Date.now();

      // Log định kỳ mỗi 60 giây vào terminal để user luôn thấy bot đang hoạt động
      if (this.scanTickCount % 20 === 0) {
        const liveStatus = this.isWsConnected ? '⚡ LIVE WS (0ms)' : '🌐 REST API';
        const rsiText = state.rsiValue !== undefined ? ` | RSI: ${state.rsiValue}` : '';
        this.logger.log(
          `🔍 [XAU/USD M5 Scanner | ${liveStatus}] Giá: $${state.currentPrice} | BB: [${state.bbLower} - ${state.bbUpper}]${rsiText} | Trạng thái: ${state.signal}`,
        );
      }
      this.scanTickCount++;

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

      // KIỂM TRA QUÉT THANH KHOẢN (LIQUIDITY SWEEP) KHUNG M15 CHO TÍN HIỆU M5
      const expectedDirection = isSellSide ? 'SELL' : 'BUY';
      let sweepSignal: SweepSignal = { hasSweep: false };
      try {
        const m15Data = await this.fetchCandles('XAU', 'M15', 100);
        if (m15Data?.candles && this.liveCandles.length > 0) {
          sweepSignal = this.liquiditySweepService.checkRecentSweep(
            this.liveCandles,
            m15Data.candles,
            expectedDirection,
            state.atrValue,
          );
        }
      } catch (e: any) {
        this.logger.debug(`Không thể quét liquidity sweep M15: ${e.message}`);
      }

      state.sweepSignal = sweepSignal;
      // NẾU CÓ QUÉT THANH KHOẢN -> NÂNG CẤP LÊN TIER 3 (🔥🔥🔥 3 ĐỐM LỬA)
      if (sweepSignal.hasSweep) {
        state.alertTier = 3;
      }

      // Quản lý cảnh báo theo từng nến M5:
      // 1. Nến M5 MỚI: BÁO NGAY!
      // 2. CÙNG NẾN: Nâng cấp Tier (0 -> 1 -> 2 -> 3): BÁO NÂNG CẤP NGAY!
      // 3. CÙNG NẾN: Nếu duy trì ngoài dải sau 90 giây cooldown -> Báo nhắc lại!
      const candleTime = state.candleTime || Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000);
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

        if (sweepSignal.hasSweep && sweepSignal.pool?.id) {
          this.liquiditySweepService.markPoolAsSwept(sweepSignal.pool.id);
        }

        // TIER 3 (VIP - CÓ QUÉT THANH KHOẢN):
        // Nếu user BẬT Tier VIP -> Báo cho user (kể cả user tắt cảnh báo BB hay tắt NWE/SMC)!
        // Nếu user TẮT riêng Tier VIP -> Không gửi cho user đó.
        // TIER 0, 1, 2: Gửi cho người dùng có BẬT cảnh báo BB
        const subscribers =
          state.alertTier === 3
            ? await this.getAllRegisteredUsersForTier2()
            : await this.getAllUsersForGlobalAlert();

        if (subscribers.length === 0) {
          this.logger.warn('⚠️ Có tín hiệu BB+ATR nhưng chưa tìm thấy người dùng nhận tin.');
          return false;
        }

        const alertMessage = this.renderAlertMessage(state, state.signal);

        let sentCount = 0;
        for (const sub of subscribers) {
          // Với Tier 0, 1, 2: kiểm tra bộ lọc xu hướng trong ngày (Bias)
          if (state.alertTier !== 3) {
            if (isSellSide && sub.bias === 'BUY_ONLY') {
              continue;
            }
            if (isBuySide && sub.bias === 'SELL_ONLY') {
              continue;
            }
          }

          try {
            await this.telegramService.sendMessage(sub.chatId, alertMessage, {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '📊 Xem Bảng BB+ATR M5', callback_data: 'bbatr_view:XAU:M5' },
                    { text: '⚙️ Bật/Tắt Cảnh Báo', callback_data: 'bbatr_toggle' },
                  ],
                ],
              },
            });
            sentCount++;
          } catch (err: any) {
            this.logger.warn(`Lỗi gửi BB+ATR alert tới ${sub.chatId}: ${err.message}`);
          }
        }

        // Ghi log vào Database
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
                entryTarget: isSellSide ? state.upperEntry : state.lowerEntry,
                slPrice: isSellSide ? state.sellSl : state.buySl,
                message: state.signalReason,
              },
            }),
          );
        } catch (dbErr) {
          // Bỏ qua nếu bảng log chưa tồn tại
        }

        const tierName =
          state.alertTier === 3
            ? 'TIER 3 (SWEEP 🔥🔥🔥)'
            : state.alertTier === 2
            ? 'TIER 2 (BB+ATR+RSI 🔥🔥)'
            : state.alertTier === 1
            ? 'TIER 1 (BB+ATR 🔥)'
            : 'NORMAL TOUCH BB (🔔)';
        this.logger.log(
          `🔔 [BB+ATR M5 ALERT: ${tierName}] ${state.signal} XAU/USD tại giá $${state.currentPrice} -> Đã gửi thành công tới ${sentCount} người dùng.`,
        );
        return true;
      }

      return false;
    } catch (err: any) {
      this.logger.error(`Lỗi trong checkGlobalXauM5Alert: ${err.message}`);
      return false;
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
        let sentCount = 0;
        for (const sub of subscribers) {
          try {
            await this.telegramService.sendMessage(sub.chatId, msg);
            sentCount++;
          } catch (e) {}
        }
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

      let sentCount = 0;
      for (const sub of subscribers) {
        if (isSellSide && sub.bias === 'BUY_ONLY') continue;
        if (isBuySide && sub.bias === 'SELL_ONLY') continue;

        try {
          await this.telegramService.sendMessage(sub.chatId, alertMessage);
          sentCount++;
        } catch (e) {}
      }

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
              (state.signal as any) === 'SELL';
            const isBuySide =
              state.signal === 'TOUCH_LOWER_BB' ||
              state.signal === 'ENTRY_BUY' ||
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
          if (state.signal === 'SELL') {
            statusText = `🔴 Chạm điểm BÁN ($${state.upperEntry})`;
          } else if (state.signal === 'BUY') {
            statusText = `🟢 Chạm điểm MUA ($${state.lowerEntry})`;
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
   * Định dạng giá
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
   * Format tin nhắn bảng Dashboard xem thông số trực quan BB+ATR
   */
  renderDashboardMessage(
    state: BbAtrState,
    isAlertEnabled: boolean,
    bias: BbAtrBias = 'BOTH',
    isTier2Enabled = true,
  ): string {
    const isGold = state.assetType === 'GOLD';
    const alertStatusText = isAlertEnabled ? '🟢 ĐANG BẬT (Tự động nhận tin)' : '⚪ ĐÃ TẮT';

    let biasText = '⚖️ Cả 2 Chiều (Buy & Sell)';
    if (bias === 'BUY_ONLY') biasText = '🟢 Chỉ Canh MUA (Bỏ qua Bán)';
    if (bias === 'SELL_ONLY') biasText = '🔴 Chỉ Canh BÁN (Bỏ qua Mua)';

    const nowStr = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date());

    let signalBadge = '⚪ VÙNG TRUNG TÍNH (Dao động trong dải)';
    if (state.alertTier === 3) {
      signalBadge = '🔥🔥🔥 [TIER 3] QUÉT THANH KHOẢN + BB + ATR (VIP)';
    } else if (state.alertTier === 2) {
      signalBadge =
        state.signal === 'ENTRY_SELL'
          ? '🔥🔥 [TIER 2] HỢP LƯU ENTRY BÁN (BB UPPER + ATR) + RSI QUÁ MUA (≥ 70)'
          : '🔥🔥 [TIER 2] HỢP LƯU ENTRY MUA (BB LOWER - ATR) + RSI QUÁ BÁN (≤ 30)';
    } else if (state.alertTier === 1) {
      signalBadge =
        state.signal === 'ENTRY_SELL'
          ? '🔥 [TIER 1] KHỚP VÙNG ENTRY BÁN: BB UPPER + ATR(14)'
          : '🔥 [TIER 1] KHỚP VÙNG ENTRY MUA: BB LOWER - ATR(14)';
    } else if (state.signal === 'SELL_CONFLUENCE') {
      signalBadge = '🎯 CHẠM BB TRÊN + RSI QUÁ MUA (≥ 70)';
    } else if (state.signal === 'BUY_CONFLUENCE') {
      signalBadge = '🎯 CHẠM BB DƯỚI + RSI QUÁ BÁN (≤ 30)';
    } else if (state.signal === 'TOUCH_UPPER_BB') {
      signalBadge = '🔴 ĐANG CHẠM BB TRÊN (Bands Upper)';
    } else if (state.signal === 'TOUCH_LOWER_BB') {
      signalBadge = '🟢 ĐANG CHẠM BB DƯỚI (Bands Lower)';
    }

    const distUpSign = state.distToUpper >= 0 ? '+' : '';
    const distDownSign = state.distToLower >= 0 ? '-' : '+';

    let msg = `🎯 <b>CHIẾN LƯỢC TRADING: BOLLINGER BANDS (20) + ATR (14)</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💎 <b>Tài sản:</b> <code>${state.displaySymbol}</code>\n`;
    msg += `⏳ <b>Khung thời gian:</b> <b>${this.timeframeLabels[state.timeframe] || state.timeframe}</b>\n`;
    msg += `💰 <b>Giá hiện tại:</b> <code>${this.formatPrice(state.currentPrice, state.assetType)}</code>\n`;
    msg += `🕒 <i>Cập nhật: ${nowStr}</i>\n\n`;

    msg += `🎯 <b>KẾ HOẠCH VÀO LỆNH & CẮT LỖ (SL = 1 ATR):</b>\n`;
    msg += `🔴 <b>Vùng Bán (Sell Entry):</b> <code>${this.formatPrice(state.upperEntry, state.assetType)}</code>\n`;
    msg += `   ↳ <b>Cắt Lỗ (SL):</b> <code>${this.formatPrice(state.sellSl, state.assetType)}</code> (+${this.formatPrice(state.slDistance, state.assetType)})\n`;
    msg += `   ↳ <i>Khoảng cách: ${distUpSign}${this.formatPrice(Math.abs(state.distToUpper), state.assetType)} (${distUpSign}${state.distToUpperPercent}%)</i>\n\n`;

    msg += `🟢 <b>Vùng Mua (Buy Entry):</b> <code>${this.formatPrice(state.lowerEntry, state.assetType)}</code>\n`;
    msg += `   ↳ <b>Cắt Lỗ (SL):</b> <code>${this.formatPrice(state.buySl, state.assetType)}</code> (-${this.formatPrice(state.slDistance, state.assetType)})\n`;
    msg += `   ↳ <i>Khoảng cách: ${distDownSign}${this.formatPrice(Math.abs(state.distToLower), state.assetType)} (${distDownSign}${state.distToLowerPercent}%)</i>\n\n`;

    msg += `📊 <b>CHỈ SỐ THÀNH PHẦN:</b>\n`;
    msg += `• Bands(20) Upper:  <code>${this.formatPrice(state.bbUpper, state.assetType)}</code>\n`;
    msg += `• Bands(20) Middle: <code>${this.formatPrice(state.bbMiddle, state.assetType)}</code>\n`;
    msg += `• Bands(20) Lower:  <code>${this.formatPrice(state.bbLower, state.assetType)}</code>\n`;
    msg += `• ATR(14): <code>${state.atrValue.toFixed(2)}</code>\n`;
    if (state.rsiValue !== undefined) {
      const rsiBadge =
        state.rsiValue <= 30
          ? ' <i>[🟢 Quá Bán ≤ 30]</i>'
          : state.rsiValue >= 70
          ? ' <i>[🔴 Quá Mua ≥ 70]</i>'
          : ' <i>[⚪ Trung Tính]</i>';
      msg += `• RSI(14): <code>${state.rsiValue.toFixed(2)}</code>${rsiBadge}\n`;
    }
    msg += `\n`;

    msg += `⚡ <b>Trạng thái:</b> <b>${signalBadge}</b>\n`;
    msg += `🧭 <b>Lọc xu hướng ngày (Bias):</b> <b>${biasText}</b>\n`;
    if (isGold) {
      msg += `🔔 <b>Cảnh báo tự động XAU M5:</b> <b>${alertStatusText}</b>\n`;
      msg += `🔥 <b>Cảnh báo Tier 3 (Quét thanh khoản):</b> <b>${isTier2Enabled ? '🟢 ĐANG BẬT (Ưu tiên cao nhất)' : '⚪ ĐÃ TẮT'}</b>\n`;
    }

    return msg;
  }

  /**
   * Format tin nhắn cảnh báo khi thị trường khớp điều kiện Entry
   */
  renderAlertMessage(state: BbAtrState, signalType: BbAtrSignalType): string {
    const isSell =
      signalType === 'ENTRY_SELL' ||
      signalType === 'SELL_CONFLUENCE' ||
      signalType === 'TOUCH_UPPER_BB' ||
      (signalType as any) === 'SELL';

    const entryPrice = isSell ? state.upperEntry : state.lowerEntry;
    const slPrice = isSell ? state.sellSl : state.buySl;
    const tp1Price = state.bbMiddle;
    const tp2Price = isSell
      ? Number((state.upperEntry - 2 * state.slDistance).toFixed(4))
      : Number((state.lowerEntry + 2 * state.slDistance).toFixed(4));

    const nowStr = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date());

    const tier = state.alertTier ?? 0;
    const sweep = state.sweepSignal;
    const isTier3 = tier === 3 && sweep?.hasSweep && !!sweep.pool;

    let headerEmoji = '🔔🔴';
    let headerTitle = 'CẢNH BÁO: GIÁ CHẠM DẢI TRÊN BOLLINGER BANDS (BANDS UPPER)!';
    let actionText = '';
    let adviceText = '';
    let sweepBlock = '';

    // ==========================================
    // CẤP ĐỘ 3: 🔥🔥🔥 TIER 3 (QUÉT THANH KHOẢN + BB + ATR)
    // ==========================================
    if (isTier3 && sweep?.pool) {
      headerEmoji = '🔥🔥🔥 ' + (isSell ? '🔴🔴' : '🟢🟢');
      headerTitle = '[TIER 3 - VIP] QUÉT THANH KHOẢN + CHIẾN LƯỢC BOLLINGER BANDS (20) & ATR (14)';

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

      actionText = isSell
        ? `🔴 Nến M5 vừa quét thanh khoản đỉnh M15 kết hợp chạm dải BB/ATR tại <code>${this.formatPrice(state.currentPrice, state.assetType)}</code>`
        : `🟢 Nến M5 vừa quét thanh khoản đáy M15 kết hợp chạm dải BB/ATR tại <code>${this.formatPrice(state.currentPrice, state.assetType)}</code>`;

      adviceText =
        '💡 <b>Khuyến nghị chiến lược [TIER 3 - TỐI THƯỢNG]:</b>\n' +
        `• Đã có tín hiệu săn thanh khoản (Liquidity Sweep / SFP) của tổ chức: Quét sạch phe breakout và đảo chiều rút râu cực mạnh!\n` +
        `• Tỷ lệ thắng (Winrate) và R:R của kèo này vượt trội nhất hệ thống. Ưu tiên vào lệnh <b>${isSell ? 'SELL / SHORT' : 'BUY / LONG'}</b> với SL ngay sau râu nến quét!`;
    }
    // ==========================================
    // CẤP ĐỘ 2: 🔥🔥 TIER 2 (BB + ATR + RSI CỰC TRỊ)
    // ==========================================
    else if (tier === 2) {
      headerEmoji = '🔥🔥 ' + (isSell ? '🔴🔴' : '🟢🟢');
      headerTitle = isSell
        ? '[TIER 2] HỢP LƯU ENTRY SELL (BB UPPER + ATR) + RSI QUÁ MUA (≥ 70)!'
        : '[TIER 2] HỢP LƯU ENTRY BUY (BB LOWER - ATR) + RSI QUÁ BÁN (≤ 30)!';

      if (isSell) {
        actionText =
          `🔴 <b>ĐÃ THỎA MÃN ĐỒNG THỜI CẢ 2 TIÊU CHÍ HỢP LƯU TIER 2 (M5):</b>\n` +
          `  1️⃣ <b>Khớp Entry BB + ATR:</b> Giá nến M5 (<code>${this.formatPrice(state.currentPrice, state.assetType)}</code>) đã bung vượt <b>Bands(20) Upper + ATR(14) (${this.formatPrice(state.upperEntry, state.assetType)})</b>\n` +
          `  2️⃣ <b>Chỉ báo RSI Quá Mua:</b> <b>RSI(14) = <code>${state.rsiValue !== undefined ? state.rsiValue.toFixed(2) : '≥ 70'}</code></b> (Đạt ngưỡng <b>≥ 70</b>)`;
        adviceText =
          '💡 <b>Khuyến nghị chiến lược [TIER 2 - XÁC SUẤT CAO]:</b>\n' +
          '• Hợp lưu kép mạnh mẽ: Biên độ tăng bị kéo giãn kịch trần (Overbought Exhaustion) kết hợp RSI cực đại ≥ 70.\n' +
          '• Tỷ lệ thắng (Winrate) rất cao! Thích hợp mở vị thế <b>SELL / SHORT</b> với quản trị vốn Stop Loss = 1 ATR.';
      } else {
        actionText =
          `🟢 <b>ĐÃ THỎA MÃN ĐỒNG THỜI CẢ 2 TIÊU CHÍ HỢP LƯU TIER 2 (M5):</b>\n` +
          `  1️⃣ <b>Khớp Entry BB - ATR:</b> Giá nến M5 (<code>${this.formatPrice(state.currentPrice, state.assetType)}</code>) đã đâm thủng <b>Bands(20) Lower - ATR(14) (${this.formatPrice(state.lowerEntry, state.assetType)})</b>\n` +
          `  2️⃣ <b>Chỉ báo RSI Quá Bán:</b> <b>RSI(14) = <code>${state.rsiValue !== undefined ? state.rsiValue.toFixed(2) : '≤ 30'}</code></b> (Đạt ngưỡng <b>≤ 30</b>)`;
        adviceText =
          '💡 <b>Khuyến nghị chiến lược [TIER 2 - XÁC SUẤT CAO]:</b>\n' +
          '• Hợp lưu kép mạnh mẽ: Biên độ giảm bị nén cực độ (Oversold Exhaustion) kết hợp RSI chạm đáy ≤ 30.\n' +
          '• Tỷ lệ thắng (Winrate) rất cao! Thích hợp giải ngân lệnh <b>BUY / LONG</b> với quản trị vốn Stop Loss = 1 ATR.';
      }
    }
    // ==========================================
    // CẤP ĐỘ 1: 🔥 TIER 1 (BB + ATR: UPPER + ATR / LOWER - ATR)
    // ==========================================
    else if (tier === 1) {
      headerEmoji = '🔥 ' + (isSell ? '🔴🔴' : '🟢🟢');
      headerTitle = isSell
        ? '[TIER 1] KHỚP VÙNG ENTRY SELL: BANDS(20) UPPER + ATR(14)!'
        : '[TIER 1] KHỚP VÙNG ENTRY BUY: BANDS(20) LOWER - ATR(14)!';

      const rsiSub = state.rsiValue !== undefined ? `\n• Chỉ số RSI(14): <b>${state.rsiValue.toFixed(2)}</b>` : '';

      if (isSell) {
        actionText =
          `🔴 Giá nến M5 (<code>${this.formatPrice(state.currentPrice, state.assetType)}</code>) đã bung ra ngoài dải trên thêm 1 ATR(14) (<code>${this.formatPrice(state.upperEntry, state.assetType)}</code>)${rsiSub}\n` +
          `• Công thức Entry: <b>Bands(20) Upper + ATR(14)</b>`;
        adviceText =
          '💡 <b>Khuyến nghị chiến lược [TIER 1]:</b>\n' +
          '• Giá đã vượt ra ngoài dải Bollinger Upper 1 khoảng bằng 1 ATR(14). Lực mua suy kiệt (Overbought Exhaustion).\n' +
          '• Thích hợp mở vị thế <b>SELL / SHORT</b> hoặc chốt lời vị thế BUY trước đó với Stop Loss = 1 ATR.';
      } else {
        actionText =
          `🟢 Giá nến M5 (<code>${this.formatPrice(state.currentPrice, state.assetType)}</code>) đã đâm thủng ra ngoài dải dưới thêm 1 ATR(14) (<code>${this.formatPrice(state.lowerEntry, state.assetType)}</code>)${rsiSub}\n` +
          `• Công thức Entry: <b>Bands(20) Lower - ATR(14)</b>`;
        adviceText =
          '💡 <b>Khuyến nghị chiến lược [TIER 1]:</b>\n' +
          '• Giá đã rơi ra ngoài dải Bollinger Lower 1 khoảng bằng 1 ATR(14). Lực bán cạn kiệt (Oversold Exhaustion).\n' +
          '• Thích hợp mở vị thế <b>BUY / LONG</b> bắt sóng hồi phục kỹ thuật với Stop Loss = 1 ATR.';
      }
    }
    // ==========================================
    // CẤP ĐỘ 0: 🔔 CHẠM DẢI BOLLINGER BANDS THÔNG THƯỜNG
    // ==========================================
    else {
      headerEmoji = isSell ? '🔔🔴' : '🔔🟢';
      headerTitle = isSell
        ? 'CẢNH BÁO: GIÁ CHẠM DẢI TRÊN BOLLINGER BANDS (BANDS UPPER)!'
        : 'CẢNH BÁO: GIÁ CHẠM DẢI DƯỚI BOLLINGER BANDS (BANDS LOWER)!';

      const rsiSub = state.rsiValue !== undefined ? ` (RSI: <code>${state.rsiValue.toFixed(2)}</code>)` : '';

      if (isSell) {
        actionText = `🔴 Giá nến M5 (<code>${this.formatPrice(state.currentPrice, state.assetType)}</code>) đã chạm/vượt dải trên <b>Bands(20) Upper (${this.formatPrice(state.bbUpper, state.assetType)})</b>${rsiSub}`;
        adviceText =
          '💡 <b>Khuyến nghị kỹ thuật:</b>\n' +
          '• Giá đã chạm dải biên trên Bollinger Bands (vùng Quá Mua).\n' +
          '• Thích hợp quan sát nến đảo chiều hoặc chờ giá chạm vùng Entry mở rộng (BB Upper + ATR) / RSI ≥ 70.';
      } else {
        actionText = `🟢 Giá nến M5 (<code>${this.formatPrice(state.currentPrice, state.assetType)}</code>) đã chạm/thủng dải dưới <b>Bands(20) Lower (${this.formatPrice(state.bbLower, state.assetType)})</b>${rsiSub}`;
        adviceText =
          '💡 <b>Khuyến nghị kỹ thuật:</b>\n' +
          '• Giá đã chạm dải biên dưới Bollinger Bands (vùng Quá Bán).\n' +
          '• Thích hợp quan sát nến rút chân phục hồi hoặc chờ giá chạm vùng Entry mở rộng (BB Lower - ATR) / RSI ≤ 30.';
      }
    }

    let msg = `${headerEmoji} <b>${headerTitle}</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    if (sweepBlock) {
      msg += `${sweepBlock}`;
    }
    if (state.consecutiveTouches && state.consecutiveTouches > 1) {
      msg += `⚠️ <b>CẢNH BÁO NẾN LIÊN TIẾP:</b> Nến M5 thứ <b>${state.consecutiveTouches}</b> liên tiếp tiếp tục chạm/thủng dải ${isSell ? 'trên' : 'dưới'}!\n\n`;
    }
    msg += `💎 <b>Tài sản:</b> <code>${state.displaySymbol}</code>\n`;
    msg += `⏳ <b>Khung thời gian:</b> <b>${this.timeframeLabels[state.timeframe] || state.timeframe}</b>\n`;
    msg += `💵 <b>Giá thị trường hiện tại:</b> <code>${this.formatPrice(state.currentPrice, state.assetType)}</code>\n\n`;

    msg += `⚡ <b>Hiện tượng khớp điều kiện:</b>\n`;
    msg += `${actionText}\n\n`;

    const effectiveSlPrice = isTier3 && sweep?.suggestedSL ? sweep.suggestedSL : slPrice;
    const effectiveSlDesc = isTier3 && sweep?.suggestedSL ? '<b>(⭐ Sau râu quét + 0.2 ATR)</b>' : '<b>(= 1 ATR)</b>';

    msg += `🎯 <b>KẾ HOẠCH VÀO LỆNH & CẮT LỖ (QUẢN TRỊ RỦI RO):</b>\n`;
    msg += `• 🎯 <b>Điểm vào lệnh (${isSell ? 'SELL' : 'BUY'} Entry):</b> <code>${this.formatPrice(entryPrice, state.assetType)}</code>\n`;
    msg += `• 🛑 <b>Điểm Cắt Lỗ (Stop Loss):</b> <code>${this.formatPrice(effectiveSlPrice, state.assetType)}</code> ${effectiveSlDesc}\n`;
    msg += `   ↳ <i>Biên độ SL: ${this.formatPrice(Math.abs(entryPrice - effectiveSlPrice), state.assetType)}</i>\n`;
    msg += `• 🎯 <b>Mục tiêu TP1 (BB Middle):</b> <code>${this.formatPrice(tp1Price, state.assetType)}</code>\n`;
    msg += `• 🎯 <b>Mục tiêu TP2 (Tỷ lệ 1:2 R:R):</b> <code>${this.formatPrice(tp2Price, state.assetType)}</code>\n\n`;

    msg += `📊 <b>THÔNG SỐ KỸ THUẬT:</b>\n`;
    msg += `• Bands(20) Upper: <code>${this.formatPrice(state.bbUpper, state.assetType)}</code>\n`;
    msg += `• Bands(20) Middle: <code>${this.formatPrice(state.bbMiddle, state.assetType)}</code>\n`;
    msg += `• Bands(20) Lower: <code>${this.formatPrice(state.bbLower, state.assetType)}</code>\n`;
    msg += `• ATR(14): <code>${state.atrValue.toFixed(2)}</code>\n`;
    if (state.rsiValue !== undefined) {
      msg += `• RSI(14): <code>${state.rsiValue.toFixed(2)}</code>\n`;
    }
    msg += `⏱ <b>Thời gian phát hiện:</b> <code>${nowStr}</code>\n\n`;

    msg += `${adviceText}`;

    return msg;
  }
}
