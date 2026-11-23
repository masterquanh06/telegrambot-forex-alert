import { BbAtrSignalType, CandleData } from './bb-atr.interface';

export type SignalDirection = 'BUY' | 'SELL';

export type TierReason =
  | 'TIER_3_M5_WICK'
  | 'TIER_2A_RSI'
  | 'TIER_2B_M5_WICK'
  | 'TIER_1_BB_ATR'
  | 'TIER_0_BB_TOUCH'
  | 'NORMAL';

export interface ClassifySignalInput {
  price: number;
  high: number;
  low: number;
  bbUpper: number;
  bbLower: number;
  atr: number;
  rsi?: number;
  candle?: CandleData;
  prevCandle?: CandleData;
  nowMs?: number;
  candleDurationMs?: number;
  isCandleClosed?: boolean;
}

export interface ClassifySignalResult {
  signal: BbAtrSignalType;
  alertTier: 0 | 1 | 2 | 3;
  tierReason: TierReason;
  signalReason: string;
  isRsiOverbought: boolean;
  isRsiOversold: boolean;
  rejectionCandleTime?: number;
}

export const M5_DURATION_MS = 5 * 60 * 1000;
export const M15_DURATION_MS = 15 * 60 * 1000;
export const WICK_ELAPSED_RATIO_THRESHOLD = 0.8;

/**
 * Chuẩn hóa timestamp về milliseconds (TradingView WS có thể trả Unix seconds, Binance trả ms)
 */
export function normalizeCandleTimeMs(time: number): number {
  if (!Number.isFinite(time) || time <= 0) return 0;
  return time < 1e12 ? time * 1000 : time;
}

/**
 * Lõi kiểm tra hình dáng nến rút râu từ chối (dùng chung cho cả mốc giá đơn và vùng Order Block):
 * - Lọc nhiễu nến bé: totalRange >= 0.5 * atr
 * - Chiều dài râu tối thiểu: >= 0.25 * atr
 * - Vị trí đóng cửa: closePos <= 0.45 (SELL) hoặc >= 0.55 (BUY)
 * - Thỏa Dạng A (Pinbar >= 45% bất kể màu) HOẶC Dạng B (nến đảo chiều thuận màu >= 25%)
 */
function hasValidRejectionWickShape(
  candle: CandleData,
  atr: number,
  direction: SignalDirection,
): boolean {
  const totalRange = candle.high - candle.low;
  if (totalRange <= 0 || atr <= 0) {
    return false;
  }

  // Lọc nhiễu nến bé bắt buộc: totalRange >= 0.5 * atr
  if (totalRange < 0.5 * atr) {
    return false;
  }

  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const closePos = (candle.close - candle.low) / totalRange;

  if (direction === 'SELL') {
    if (upperWick < 0.25 * atr) return false;
    if (closePos > 0.45) return false;
    const wickRatio = upperWick / totalRange;
    const isPinbar = wickRatio >= 0.45;
    const isDirectionalReversal = candle.close < candle.open && wickRatio >= 0.25;
    return isPinbar || isDirectionalReversal;
  }

  // direction === 'BUY'
  if (lowerWick < 0.25 * atr) return false;
  if (closePos < 0.55) return false;
  const wickRatio = lowerWick / totalRange;
  const isPinbar = wickRatio >= 0.45;
  const isDirectionalReversal = candle.close > candle.open && wickRatio >= 0.25;
  return isPinbar || isDirectionalReversal;
}

/**
 * Phát hiện nến M5 rút râu từ chối (Rejection Wick) tại mốc giá đơn `level` (dành cho BB + ATR)
 * Pure function — không phụ thuộc runtime/DB/Telegram, tái sử dụng trực tiếp cho Backtest.
 */
export function detectM5RejectionWick(
  candle: CandleData | null | undefined,
  level: number,
  atr: number,
  direction: SignalDirection,
): boolean {
  if (!candle || !Number.isFinite(level) || !Number.isFinite(atr) || atr <= 0) {
    return false;
  }

  if (direction === 'SELL') {
    if (!(candle.high > level && candle.close < level)) {
      return false;
    }
  } else {
    if (!(candle.low < level && candle.close > level)) {
      return false;
    }
  }

  return hasValidRejectionWickShape(candle, atr, direction);
}

/**
 * Phát hiện nến rút râu từ chối bên trong vùng hợp lưu (Zone Rejection Wick — dành cho NWE H1 + OB rộng):
 * - SELL: candle.high >= entryLevel (chọc vào cả NWE H1 lẫn Supply OB) VÀ candle.close < invalidationLevel (không phá vỡ ob.top)
 * - BUY:  candle.low <= entryLevel (chọc vào cả NWE H1 lẫn Demand OB) VÀ candle.close > invalidationLevel (không phá vỡ ob.bottom)
 * - Giữ nguyên lõi lọc hình dáng râu & chống nhiễu (totalRange >= 0.5 ATR, wick >= 0.25 ATR, closePos, Dạng A/B).
 */
export function detectZoneRejectionWick(
  candle: CandleData | null | undefined,
  entryLevel: number,
  invalidationLevel: number,
  atr: number,
  direction: SignalDirection,
): boolean {
  if (
    !candle ||
    !Number.isFinite(entryLevel) ||
    !Number.isFinite(invalidationLevel) ||
    !Number.isFinite(atr) ||
    atr <= 0
  ) {
    return false;
  }

  if (direction === 'SELL') {
    if (!(candle.high >= entryLevel && candle.close < invalidationLevel)) {
      return false;
    }
  } else {
    if (!(candle.low <= entryLevel && candle.close > invalidationLevel)) {
      return false;
    }
  }

  return hasValidRejectionWickShape(candle, atr, direction);
}

/**
 * Chọn cây nến hợp lệ để kiểm tra rút râu M5 (chống rút râu ảo đầu nến):
 * - Nếu `isCandleClosed === true` hoặc nến đang chạy đã đi qua >= 80% thời gian (>= phút thứ 4 của nến M5) -> dùng `candle`
 * - Ngược lại, nếu có `prevCandle` (nến M5 vừa đóng) -> dùng `prevCandle`
 */
function selectWickCandidateCandle(
  candle: CandleData | undefined,
  prevCandle: CandleData | undefined,
  nowMs: number,
  candleDurationMs: number,
  isCandleClosed?: boolean,
): CandleData | undefined {
  if (candle) {
    if (isCandleClosed === true) {
      return candle;
    }
    const candleTimeMs = normalizeCandleTimeMs(candle.time);
    if (candleTimeMs > 0 && nowMs - candleTimeMs >= WICK_ELAPSED_RATIO_THRESHOLD * candleDurationMs) {
      return candle;
    }
  }

  if (prevCandle) {
    return prevCandle;
  }

  return undefined;
}

/**
 * Pure Signal Engine phân loại tín hiệu BB + ATR + RSI + Nến rút râu M5 theo thứ tự ưu tiên từ trên xuống dưới:
 * - Tier 3 (VIP): detectM5RejectionWick tại mốc BB Upper + ATR (SELL) hoặc BB Lower - ATR (BUY)
 * - Tier 2A: BB ± ATR + RSI cực trị (>= 70 / <= 30)
 * - Tier 2B: detectM5RejectionWick ngay tại mốc BB Upper (SELL) hoặc BB Lower (BUY)
 * - Tier 1: Giá chạm/vượt BB Upper + ATR (SELL) hoặc BB Lower - ATR (BUY)
 * - Tier 0: Giá chạm dải BB Upper / BB Lower thông thường
 */
export function classifySignalTier(input: ClassifySignalInput): ClassifySignalResult {
  const {
    price,
    high,
    low,
    bbUpper,
    bbLower,
    atr,
    rsi,
    candle,
    prevCandle,
    nowMs = Date.now(),
    candleDurationMs = M5_DURATION_MS,
    isCandleClosed,
  } = input;

  const upperEntry = bbUpper + atr;
  const lowerEntry = bbLower - atr;

  const isTouchUpper = price >= bbUpper || high >= bbUpper;
  const isTouchLower = price <= bbLower || low <= bbLower;
  const isEntrySell = price >= upperEntry || high >= upperEntry;
  const isEntryBuy = price <= lowerEntry || low <= lowerEntry;

  const isRsiOverbought = rsi !== undefined && rsi >= 70;
  const isRsiOversold = rsi !== undefined && rsi <= 30;
  const rsiLabel = rsi !== undefined ? rsi.toFixed(1) : 'N/A';

  const wickCandle = selectWickCandidateCandle(candle, prevCandle, nowMs, candleDurationMs, isCandleClosed);
  const wickCandleTime = wickCandle ? normalizeCandleTimeMs(wickCandle.time) : undefined;

  // =========================================================
  // 1. TIER 3 (VIP): Nến rút râu M5 tại mốc BB Upper + ATR / BB Lower - ATR
  //    (Không yêu cầu isEntrySell/isEntryBuy trên nến hiện tại để không bỏ sót
  //     tín hiệu trên prevCandle khi vừa mở nến mới và giá đã rút vào trong)
  // =========================================================
  if (wickCandle && detectM5RejectionWick(wickCandle, upperEntry, atr, 'SELL')) {
    return {
      signal: 'ENTRY_SELL',
      alertTier: 3,
      tierReason: 'TIER_3_M5_WICK',
      signalReason: `🔥🔥🔥 [TIER 3 - VIP] BB UPPER + ATR + NẾN RÚT RÂU M5 TỪ CHỐI MẠNH! Nến M5 đâm vượt mốc $${upperEntry.toFixed(2)} và rút râu đóng thụt vào trong (Giá: $${price.toFixed(2)}, RSI: ${rsiLabel}).`,
      isRsiOverbought,
      isRsiOversold,
      rejectionCandleTime: wickCandleTime,
    };
  }

  if (wickCandle && detectM5RejectionWick(wickCandle, lowerEntry, atr, 'BUY')) {
    return {
      signal: 'ENTRY_BUY',
      alertTier: 3,
      tierReason: 'TIER_3_M5_WICK',
      signalReason: `🔥🔥🔥 [TIER 3 - VIP] BB LOWER - ATR + NẾN RÚT RÂU M5 TỪ CHỐI MẠNH! Nến M5 đâm thủng mốc $${lowerEntry.toFixed(2)} và rút râu đóng thụt vào trong (Giá: $${price.toFixed(2)}, RSI: ${rsiLabel}).`,
      isRsiOverbought,
      isRsiOversold,
      rejectionCandleTime: wickCandleTime,
    };
  }

  // =========================================================
  // 2. TIER 2 (2A HOẶC 2B)
  // =========================================================
  // - Tier 2A: BB ± ATR + RSI cực trị
  if (isEntrySell && isRsiOverbought) {
    return {
      signal: 'ENTRY_SELL',
      alertTier: 2,
      tierReason: 'TIER_2A_RSI',
      signalReason: `🔥🔥 [TIER 2A] HỢP LƯU ENTRY SELL (BB UPPER + ATR) + RSI QUÁ MUA (≥ 70)! Giá ($${price.toFixed(2)}) đã vượt mốc $${upperEntry.toFixed(2)} và RSI = ${rsiLabel}.`,
      isRsiOverbought,
      isRsiOversold,
    };
  }

  if (isEntryBuy && isRsiOversold) {
    return {
      signal: 'ENTRY_BUY',
      alertTier: 2,
      tierReason: 'TIER_2A_RSI',
      signalReason: `🔥🔥 [TIER 2A] HỢP LƯU ENTRY BUY (BB LOWER - ATR) + RSI QUÁ BÁN (≤ 30)! Giá ($${price.toFixed(2)}) đã đâm thủng mốc $${lowerEntry.toFixed(2)} và RSI = ${rsiLabel}.`,
      isRsiOverbought,
      isRsiOversold,
    };
  }

  // - Tier 2B: Nến rút râu M5 từ chối ngay tại mốc BB Upper / BB Lower
  if (wickCandle && detectM5RejectionWick(wickCandle, bbUpper, atr, 'SELL')) {
    return {
      signal: 'SELL_CONFLUENCE',
      alertTier: 2,
      tierReason: 'TIER_2B_M5_WICK',
      signalReason: `🔥🔥 [TIER 2B] NẾN RÚT RÂU M5 TỪ CHỐI TẠI DẢI BB TRÊN ($${bbUpper.toFixed(2)})! Nến M5 đâm xuyên biên trên và đóng thụt vào trong (Giá: $${price.toFixed(2)}, RSI: ${rsiLabel}).`,
      isRsiOverbought,
      isRsiOversold,
      rejectionCandleTime: wickCandleTime,
    };
  }

  if (wickCandle && detectM5RejectionWick(wickCandle, bbLower, atr, 'BUY')) {
    return {
      signal: 'BUY_CONFLUENCE',
      alertTier: 2,
      tierReason: 'TIER_2B_M5_WICK',
      signalReason: `🔥🔥 [TIER 2B] NẾN RÚT RÂU M5 TỪ CHỐI TẠI DẢI BB DƯỚI ($${bbLower.toFixed(2)})! Nến M5 đâm thủng biên dưới và đóng thụt vào trong (Giá: $${price.toFixed(2)}, RSI: ${rsiLabel}).`,
      isRsiOverbought,
      isRsiOversold,
      rejectionCandleTime: wickCandleTime,
    };
  }

  // =========================================================
  // 3. TIER 1: Khớp vùng Entry mở rộng BB ± ATR
  // =========================================================
  if (isEntrySell) {
    return {
      signal: 'ENTRY_SELL',
      alertTier: 1,
      tierReason: 'TIER_1_BB_ATR',
      signalReason: `🔥 [TIER 1] KHỚP VÙNG ENTRY SELL (BANDS UPPER + ATR)! Giá ($${price.toFixed(2)}) đã bung vượt mốc $${upperEntry.toFixed(2)} (RSI: ${rsiLabel}).`,
      isRsiOverbought,
      isRsiOversold,
    };
  }

  if (isEntryBuy) {
    return {
      signal: 'ENTRY_BUY',
      alertTier: 1,
      tierReason: 'TIER_1_BB_ATR',
      signalReason: `🔥 [TIER 1] KHỚP VÙNG ENTRY BUY (BANDS LOWER - ATR)! Giá ($${price.toFixed(2)}) đã đâm thủng mốc $${lowerEntry.toFixed(2)} (RSI: ${rsiLabel}).`,
      isRsiOverbought,
      isRsiOversold,
    };
  }

  // =========================================================
  // 4. TIER 0: Chạm dải BB thông thường
  // =========================================================
  if (isTouchUpper) {
    return {
      signal: isRsiOverbought ? 'SELL_CONFLUENCE' : 'TOUCH_UPPER_BB',
      alertTier: 0,
      tierReason: 'TIER_0_BB_TOUCH',
      signalReason: isRsiOverbought
        ? `Giá chạm dải BB trên ($${bbUpper.toFixed(2)}) và RSI = ${rsiLabel} (≥ 70 - Quá Mua).`
        : `Giá chạm dải BB trên ($${bbUpper.toFixed(2)}) (RSI: ${rsiLabel}).`,
      isRsiOverbought,
      isRsiOversold,
    };
  }

  if (isTouchLower) {
    return {
      signal: isRsiOversold ? 'BUY_CONFLUENCE' : 'TOUCH_LOWER_BB',
      alertTier: 0,
      tierReason: 'TIER_0_BB_TOUCH',
      signalReason: isRsiOversold
        ? `Giá chạm dải BB dưới ($${bbLower.toFixed(2)}) và RSI = ${rsiLabel} (≤ 30 - Quá Bán).`
        : `Giá chạm dải BB dưới ($${bbLower.toFixed(2)}) (RSI: ${rsiLabel}).`,
      isRsiOverbought,
      isRsiOversold,
    };
  }

  return {
    signal: 'NORMAL',
    alertTier: 0,
    tierReason: 'NORMAL',
    signalReason: 'Giá đang nằm trong dải dao động an toàn.',
    isRsiOverbought,
    isRsiOversold,
  };
}
