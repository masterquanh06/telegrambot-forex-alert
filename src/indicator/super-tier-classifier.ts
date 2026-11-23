import { normalizeCandleTimeMs } from './signal-classifier';

export type Tier3Source = 'BB_ATR' | 'SMC_NWE';
export type Tier3Direction = 'BUY' | 'SELL';

export interface Tier3EventPayload {
  source: Tier3Source;
  direction: Tier3Direction;
  triggeredAtMs: number;
  candleTimeMs: number;
  currentPrice: number;
  slPrice: number;
  tp1Price?: number;
  tp2Price?: number;
  summary: string;
  details: Record<string, any>;
}

export interface TierSssResult {
  direction: Tier3Direction;
  bbEvent: Tier3EventPayload;
  smcEvent: Tier3EventPayload;
  timeDiffMs: number;
  timeDiffMinutes: number;
  entryPrice: number;
  safestSl: number;
  tp1Price?: number;
  tp2Price?: number;
  sssKey: string;
  triggeredAtMs: number;
}

export interface SssDedupState {
  lastSssKey?: string;
  lastSssDirection?: Tier3Direction;
  lastSssAlertTime?: number;
}

/** Cửa sổ hợp lưu mặc định giữa BB+ATR M5 Tier 3 và SMC+NWE M15 Tier 3: 20 phút */
export const SSS_CONFLUENCE_WINDOW_MS = 20 * 60 * 1000;

/** Cooldown chống bắn trùng Tier SSS cùng chiều: 15 phút */
export const SSS_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Pure function đánh giá siêu hợp lưu TIER SSS khi cả 2 trụ cột (BB+ATR M5 Tier 3 & SMC+NWE M15 Tier 3)
 * cùng chiều và nằm trong cửa sổ thời gian hợp lưu `windowMs` (mặc định 20 phút).
 */
export function evaluateTierSss(
  bbEvent: Tier3EventPayload | null | undefined,
  smcEvent: Tier3EventPayload | null | undefined,
  windowMs = SSS_CONFLUENCE_WINDOW_MS,
): TierSssResult | null {
  if (!bbEvent || !smcEvent) {
    return null;
  }

  // 1. Bắt buộc cùng chiều tuyệt đối
  if (bbEvent.direction !== smcEvent.direction) {
    return null;
  }

  // 2. Bắt buộc nằm trong cửa sổ hợp lưu (Sliding Window)
  const timeDiffMs = Math.abs(bbEvent.triggeredAtMs - smcEvent.triggeredAtMs);
  if (timeDiffMs > windowMs) {
    return null;
  }

  const direction = bbEvent.direction;

  // 3. Kế hoạch hợp nhất:
  //    - SL an toàn nhất (rộng hơn giữa 2 hệ thống): max cho SELL, min cho BUY
  //    - Entry tham chiếu: giá thị trường của tín hiệu kích hoạt sau cùng (mới nhất)
  //    - TP1: BB Middle (M5) từ bbEvent
  //    - TP2: NWE H1 Kernel từ smcEvent
  const safestSl =
    direction === 'SELL'
      ? Number(Math.max(bbEvent.slPrice, smcEvent.slPrice).toFixed(2))
      : Number(Math.min(bbEvent.slPrice, smcEvent.slPrice).toFixed(2));

  const latestEvent = bbEvent.triggeredAtMs >= smcEvent.triggeredAtMs ? bbEvent : smcEvent;
  const entryPrice = Number(latestEvent.currentPrice.toFixed(2));
  const tp1Price = bbEvent.tp1Price !== undefined ? Number(bbEvent.tp1Price.toFixed(2)) : undefined;
  const rawTp2 = smcEvent.tp1Price ?? smcEvent.tp2Price;
  const tp2Price = rawTp2 !== undefined ? Number(rawTp2.toFixed(2)) : undefined;

  const bbCandleMs = normalizeCandleTimeMs(bbEvent.candleTimeMs);
  const smcCandleMs = normalizeCandleTimeMs(smcEvent.candleTimeMs);
  const sssKey = `${direction}_${bbCandleMs}_${smcCandleMs}`;

  return {
    direction,
    bbEvent,
    smcEvent,
    timeDiffMs,
    timeDiffMinutes: Number((timeDiffMs / 60000).toFixed(1)),
    entryPrice,
    safestSl,
    tp1Price,
    tp2Price,
    sssKey,
    triggeredAtMs: Math.max(bbEvent.triggeredAtMs, smcEvent.triggeredAtMs),
  };
}

/**
 * Pure function kiểm tra chống bắn trùng TIER SSS:
 * - Chặn nếu trùng `lastSssKey` (cùng chiều + cùng cặp nến BB M5 & SMC M15)
 * - HOẶC vừa bắn Tier SSS CÙNG CHIỀU trong vòng `cooldownMs` (mặc định 15 phút)
 */
export function shouldSuppressDuplicateSss(
  result: TierSssResult,
  state: SssDedupState,
  nowMs = Date.now(),
  cooldownMs = SSS_COOLDOWN_MS,
): boolean {
  if (state.lastSssKey && state.lastSssKey === result.sssKey) {
    return true;
  }

  if (
    state.lastSssDirection === result.direction &&
    state.lastSssAlertTime !== undefined &&
    nowMs - state.lastSssAlertTime < cooldownMs
  ) {
    return true;
  }

  return false;
}
