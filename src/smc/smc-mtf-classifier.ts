import { CandleData } from '../indicator/bb-atr.interface';
import {
  detectZoneRejectionWick,
  M15_DURATION_MS,
  normalizeCandleTimeMs,
  WICK_ELAPSED_RATIO_THRESHOLD,
} from '../indicator/signal-classifier';
import { NweEnvelope, OrderBlock, SmcTimeframe } from './smc.interface';

export const SMC_MTF_OB_TIMEFRAMES: SmcTimeframe[] = ['M15', 'M30', 'H1', 'H4'];

const OB_TIMEFRAME_PRIORITY: Record<SmcTimeframe, number> = {
  M1: 0,
  M5: 1,
  M15: 2,
  M30: 3,
  H1: 4,
  H4: 5,
  D1: 6,
};

export type SmcMtfTierReason =
  | 'SMC_TIER_3_MTF_WICK'
  | 'SMC_TIER_2_MTF_CONFLUENCE'
  | 'NORMAL';

export interface ClassifySmcMtfInput {
  currentPrice: number;
  candleHigh: number;
  candleLow: number;
  nweH1: NweEnvelope;
  obPools: OrderBlock[];
  atrM15: number;
  m15Candle?: CandleData;
  m15PrevCandle?: CandleData;
  nowMs?: number;
  candleDurationMs?: number;
  isCandleClosed?: boolean;
}

export interface ClassifySmcMtfResult {
  signal: 'NORMAL' | 'CONFLUENCE_SELL' | 'CONFLUENCE_BUY';
  alertTier: 0 | 2 | 3;
  tierReason: SmcMtfTierReason;
  direction?: 'SELL' | 'BUY';
  matchedOrderBlocks: OrderBlock[];
  primaryOb?: OrderBlock;
  confluenceLevel?: number;
  rejectionCandleTime?: number;
  signalReason: string;
}

/**
 * Tính ATR(14) chuẩn Wilder's Smoothing trên chuỗi nến (dùng tính atrM15 cho SMC+NWE Tier 3)
 */
export function calculateWilderAtr(candles: CandleData[], period = 14): number {
  if (!candles || candles.length === 0) return 0;

  const trValues: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      trValues.push(c.high - c.low);
    } else {
      const prevClose = candles[i - 1].close;
      trValues.push(
        Math.max(
          c.high - c.low,
          Math.abs(c.high - prevClose),
          Math.abs(c.low - prevClose),
        ),
      );
    }
  }

  if (trValues.length < period) {
    const avg = trValues.reduce((acc, v) => acc + v, 0) / trValues.length;
    return Number(avg.toFixed(4));
  }

  let atr = trValues.slice(0, period).reduce((acc, v) => acc + v, 0) / period;
  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + trValues[i]) / period;
  }

  return Number(atr.toFixed(4));
}

/**
 * Chọn nến M15 hợp lệ để kiểm tra rút râu từ chối (chống rút râu ảo đầu nến):
 * - Nếu `isCandleClosed === true` hoặc nến M15 đang chạy đã đi qua >= 80% thời gian (>= phút thứ 12 / 15 phút) -> dùng `m15Candle`
 * - Ngược lại, nếu có `m15PrevCandle` (nến M15 vừa đóng) -> dùng `m15PrevCandle`
 */
function selectM15WickCandidate(
  m15Candle: CandleData | undefined,
  m15PrevCandle: CandleData | undefined,
  nowMs: number,
  candleDurationMs: number,
  isCandleClosed?: boolean,
): CandleData | undefined {
  if (m15Candle) {
    if (isCandleClosed === true) {
      return m15Candle;
    }
    const candleTimeMs = normalizeCandleTimeMs(m15Candle.time);
    if (
      candleTimeMs > 0 &&
      nowMs - candleTimeMs >= WICK_ELAPSED_RATIO_THRESHOLD * candleDurationMs
    ) {
      return m15Candle;
    }
  }

  if (m15PrevCandle) {
    return m15PrevCandle;
  }

  return undefined;
}

function sortOrderBlocksByPriority(obs: OrderBlock[]): OrderBlock[] {
  return [...obs].sort((a, b) => {
    const prioDiff = (OB_TIMEFRAME_PRIORITY[b.timeframe] || 0) - (OB_TIMEFRAME_PRIORITY[a.timeframe] || 0);
    if (prioDiff !== 0) return prioDiff;
    return b.time - a.time;
  });
}

function formatObTfList(obs: OrderBlock[]): string {
  return Array.from(new Set(obs.map((o) => o.timeframe))).join(' + ');
}

/**
 * Pure Signal Engine phân loại Hợp lưu Chéo Khung SMC + NWE:
 * - Tier 3 (VIP): NWE H1 + OB đa khung (M15, M30, H1, H4) + Nến rút râu từ chối khung M15 (detectZoneRejectionWick + atrM15)
 * - Tier 2 (MTF Confluence): Chạm biên NWE H1 + giao cắt ít nhất 1 OB từ M15, M30, H1, H4
 */
export function classifySmcMtfTier(input: ClassifySmcMtfInput): ClassifySmcMtfResult {
  const {
    currentPrice,
    candleHigh,
    candleLow,
    nweH1,
    obPools,
    atrM15,
    m15Candle,
    m15PrevCandle,
    nowMs = Date.now(),
    candleDurationMs = M15_DURATION_MS,
    isCandleClosed,
  } = input;

  const allowedTfSet = new Set<SmcTimeframe>(SMC_MTF_OB_TIMEFRAMES);
  const validObs = (obPools || []).filter((ob) => !ob.mitigated && allowedTfSet.has(ob.timeframe));
  const supplyObs = sortOrderBlocksByPriority(validObs.filter((ob) => ob.type === 'SUPPLY'));
  const demandObs = sortOrderBlocksByPriority(validObs.filter((ob) => ob.type === 'DEMAND'));

  const wickCandle = selectM15WickCandidate(
    m15Candle,
    m15PrevCandle,
    nowMs,
    candleDurationMs,
    isCandleClosed,
  );
  const wickCandleTime = wickCandle ? normalizeCandleTimeMs(wickCandle.time) : undefined;

  // =========================================================
  // 1. TIER 3 (VIP): NWE H1 + OB đa khung + Nến rút râu M15
  //    Dùng detectZoneRejectionWick để bắt chuẩn cả các cây nến M15 rút râu
  //    bên trong lòng OB rộng (H1/H4) miễn không phá vỡ ob.top / ob.bottom.
  // =========================================================
  if (wickCandle && atrM15 > 0) {
    // 1A. Chiều SELL: high >= max(nweH1.upperBand, ob.bottom) && close < ob.top
    const matchedSellWickObs = supplyObs.filter((ob) => {
      const entryLevel = Math.max(nweH1.upperBand, ob.bottom);
      return detectZoneRejectionWick(wickCandle, entryLevel, ob.top, atrM15, 'SELL');
    });

    if (matchedSellWickObs.length > 0) {
      const primaryOb = matchedSellWickObs[0];
      const confluenceLevel = Number(Math.max(nweH1.upperBand, primaryOb.bottom).toFixed(2));
      const tfList = formatObTfList(matchedSellWickObs);
      return {
        signal: 'CONFLUENCE_SELL',
        alertTier: 3,
        tierReason: 'SMC_TIER_3_MTF_WICK',
        direction: 'SELL',
        matchedOrderBlocks: matchedSellWickObs,
        primaryOb,
        confluenceLevel,
        rejectionCandleTime: wickCandleTime,
        signalReason: `🔥🔥🔥 [TIER 3 - VIP] HỢP LƯU BÁN NWE H1 ($${nweH1.upperBand.toFixed(2)}) + SUPPLY OB (${tfList}) + NẾN RÚT RÂU M15! Giá: $${currentPrice.toFixed(2)}.`,
      };
    }

    // 1B. Chiều BUY: low <= min(nweH1.lowerBand, ob.top) && close > ob.bottom
    const matchedBuyWickObs = demandObs.filter((ob) => {
      const entryLevel = Math.min(nweH1.lowerBand, ob.top);
      return detectZoneRejectionWick(wickCandle, entryLevel, ob.bottom, atrM15, 'BUY');
    });

    if (matchedBuyWickObs.length > 0) {
      const primaryOb = matchedBuyWickObs[0];
      const confluenceLevel = Number(Math.min(nweH1.lowerBand, primaryOb.top).toFixed(2));
      const tfList = formatObTfList(matchedBuyWickObs);
      return {
        signal: 'CONFLUENCE_BUY',
        alertTier: 3,
        tierReason: 'SMC_TIER_3_MTF_WICK',
        direction: 'BUY',
        matchedOrderBlocks: matchedBuyWickObs,
        primaryOb,
        confluenceLevel,
        rejectionCandleTime: wickCandleTime,
        signalReason: `🔥🔥🔥 [TIER 3 - VIP] HỢP LƯU MUA NWE H1 ($${nweH1.lowerBand.toFixed(2)}) + DEMAND OB (${tfList}) + NẾN RÚT RÂU M15! Giá: $${currentPrice.toFixed(2)}.`,
      };
    }
  }

  // =========================================================
  // 2. TIER 2 (MTF CONFLUENCE): Chạm biên NWE H1 + >= 1 OB (M15, M30, H1, H4)
  // =========================================================
  const isTouchNweUpper =
    nweH1.isTouchUpper || candleHigh >= nweH1.upperBand || currentPrice >= nweH1.upperBand;
  const isTouchNweLower =
    nweH1.isTouchLower || candleLow <= nweH1.lowerBand || currentPrice <= nweH1.lowerBand;

  if (isTouchNweUpper) {
    const matchedSellObs = supplyObs.filter(
      (ob) => candleHigh >= ob.bottom && candleLow <= ob.top,
    );
    if (matchedSellObs.length > 0) {
      const primaryOb = matchedSellObs[0];
      const confluenceLevel = Number(Math.max(nweH1.upperBand, primaryOb.bottom).toFixed(2));
      const tfList = formatObTfList(matchedSellObs);
      return {
        signal: 'CONFLUENCE_SELL',
        alertTier: 2,
        tierReason: 'SMC_TIER_2_MTF_CONFLUENCE',
        direction: 'SELL',
        matchedOrderBlocks: matchedSellObs,
        primaryOb,
        confluenceLevel,
        signalReason: `🔥🔥 [TIER 2 - MTF] HỢP LƯU BÁN CHÉO KHUNG: Dải trên NWE H1 ($${nweH1.upperBand.toFixed(2)}) + SUPPLY OB (${tfList}) [$${primaryOb.bottom.toFixed(2)} - $${primaryOb.top.toFixed(2)}].`,
      };
    }
  }

  if (isTouchNweLower) {
    const matchedBuyObs = demandObs.filter(
      (ob) => candleLow <= ob.top && candleHigh >= ob.bottom,
    );
    if (matchedBuyObs.length > 0) {
      const primaryOb = matchedBuyObs[0];
      const confluenceLevel = Number(Math.min(nweH1.lowerBand, primaryOb.top).toFixed(2));
      const tfList = formatObTfList(matchedBuyObs);
      return {
        signal: 'CONFLUENCE_BUY',
        alertTier: 2,
        tierReason: 'SMC_TIER_2_MTF_CONFLUENCE',
        direction: 'BUY',
        matchedOrderBlocks: matchedBuyObs,
        primaryOb,
        confluenceLevel,
        signalReason: `🔥🔥 [TIER 2 - MTF] HỢP LƯU MUA CHÉO KHUNG: Dải dưới NWE H1 ($${nweH1.lowerBand.toFixed(2)}) + DEMAND OB (${tfList}) [$${primaryOb.bottom.toFixed(2)} - $${primaryOb.top.toFixed(2)}].`,
      };
    }
  }

  return {
    signal: 'NORMAL',
    alertTier: 0,
    tierReason: 'NORMAL',
    matchedOrderBlocks: [],
    signalReason: 'Giá chưa khớp vùng hợp lưu chéo khung NWE H1 + Order Block.',
  };
}
