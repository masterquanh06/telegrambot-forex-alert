import { Injectable, Logger } from '@nestjs/common';
import { CandleData } from '../indicator/bb-atr.interface';

export type PoolType = 'BSL' | 'SSL'; // BSL = Buy-side Liquidity (Đỉnh cũ), SSL = Sell-side Liquidity (Đáy cũ)

export interface LiquidityPool {
  id: string;
  type: PoolType;
  price: number;
  time: number; // Timestamp ms của nến tạo đỉnh/đáy
  timeStr: string; // HH:mm (giờ Việt Nam)
  candleIndex: number;
  isMajorPool: boolean; // EQH hoặc EQL (chênh lệch <= 0.2 * ATR)
  isSwept: boolean; // Đã từng bị đâm qua trước đó hay chưa
  sweptAt?: number;
}

export type SweepType = 'BUY_SWEEP' | 'SELL_SWEEP';

export interface SweepSignal {
  hasSweep: boolean;
  type?: SweepType;
  pool?: LiquidityPool;
  sweepCandle?: CandleData;
  sweepDepth?: number;
  sweepDepthAtrRatio?: number;
  wickRatio?: number;
  suggestedSL?: number;
  description?: string;
}

@Injectable()
export class LiquiditySweepService {
  private readonly logger = new Logger(LiquiditySweepService.name);

  // Bộ nhớ đệm lưu các Pool đã bị quét để đảm bảo không báo lặp lại
  private readonly sweptPoolIds = new Set<string>();

  /**
   * Tính Average True Range (ATR) chuẩn Wilder qua 14 chu kỳ
   */
  calculateAtr(candles: CandleData[], period = 14): number {
    if (!candles || candles.length < period + 1) {
      // Fallback nếu số lượng nến ít hơn period + 1
      if (candles && candles.length > 0) {
        const trs = candles.map((c, i) =>
          i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)),
        );
        return trs.reduce((a, b) => a + b, 0) / trs.length;
      }
      return 1.0;
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

    let atr = trValues.slice(0, period).reduce((acc, val) => acc + val, 0) / period;
    for (let i = period; i < trValues.length; i++) {
      atr = (atr * (period - 1) + trValues[i]) / period;
    }

    return Number(atr.toFixed(4));
  }

  /**
   * Định dạng timestamp ra chuỗi giờ HH:mm (GMT+7)
   */
  formatTimeStr(timeMs: number): string {
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timeMs));
  }

  /**
   * Xác định Bể thanh khoản (Liquidity Pools) từ khung M15 (left = 5, right = 5, tối đa 100 nến gần nhất)
   * - BSL (Buy-side Liquidity): Pivot High (Đỉnh cũ)
   * - SSL (Sell-side Liquidity): Pivot Low (Đáy cũ)
   * - Lọc EQH / EQL (chênh lệch <= 0.2 * ATR(14)) -> isMajorPool = true
   * - Đánh dấu isSwept = true cho các mốc đã bị nến sau đó phá qua
   */
  identifyLiquidityPools(
    m15Candles: CandleData[],
    left = 5,
    right = 5,
    lookback = 100,
  ): LiquidityPool[] {
    if (!m15Candles || m15Candles.length < left + right + 1) {
      return [];
    }

    const n = m15Candles.length;
    const startIndex = Math.max(left, n - lookback);
    const endIndex = n - 1 - right; // Các nến đã đủ right nến để xác nhận pivot
    const atr = this.calculateAtr(m15Candles, 14);

    const pools: LiquidityPool[] = [];

    // 1. Quét tìm Pivot High (BSL) và Pivot Low (SSL)
    for (let i = startIndex; i <= endIndex; i++) {
      const current = m15Candles[i];
      let isPivotHigh = true;
      let isPivotLow = true;

      // Kiểm tra bên trái (left = 5)
      for (let k = 1; k <= left; k++) {
        if (m15Candles[i - k].high > current.high) isPivotHigh = false;
        if (m15Candles[i - k].low < current.low) isPivotLow = false;
      }

      // Kiểm tra bên phải (right = 5)
      for (let k = 1; k <= right; k++) {
        if (m15Candles[i + k].high >= current.high) isPivotHigh = false;
        if (m15Candles[i + k].low <= current.low) isPivotLow = false;
      }

      if (isPivotHigh) {
        pools.push({
          id: `BSL_${current.time}_${current.high.toFixed(2)}`,
          type: 'BSL',
          price: Number(current.high.toFixed(2)),
          time: current.time,
          timeStr: this.formatTimeStr(current.time),
          candleIndex: i,
          isMajorPool: false,
          isSwept: false,
        });
      }

      if (isPivotLow) {
        pools.push({
          id: `SSL_${current.time}_${current.low.toFixed(2)}`,
          type: 'SSL',
          price: Number(current.low.toFixed(2)),
          time: current.time,
          timeStr: this.formatTimeStr(current.time),
          candleIndex: i,
          isMajorPool: false,
          isSwept: false,
        });
      }
    }

    // 2. Lọc Equal Highs (EQH) và Equal Lows (EQL) (chênh lệch <= 0.2 * ATR(14))
    const eqThreshold = 0.2 * atr;

    const bslPools = pools.filter((p) => p.type === 'BSL');
    for (let i = 0; i < bslPools.length; i++) {
      for (let j = i + 1; j < bslPools.length; j++) {
        if (Math.abs(bslPools[i].price - bslPools[j].price) <= eqThreshold) {
          bslPools[i].isMajorPool = true;
          bslPools[j].isMajorPool = true;
        }
      }
    }

    const sslPools = pools.filter((p) => p.type === 'SSL');
    for (let i = 0; i < sslPools.length; i++) {
      for (let j = i + 1; j < sslPools.length; j++) {
        if (Math.abs(sslPools[i].price - sslPools[j].price) <= eqThreshold) {
          sslPools[i].isMajorPool = true;
          sslPools[j].isMajorPool = true;
        }
      }
    }

    // 3. Quản lý vòng đời Pool: Kiểm tra nến lịch sử từ sau khi tạo pivot đến nến áp chót
    // Bất kỳ nến nào sau đó đâm qua mức giá này thì pool bị đánh dấu isSwept = true
    for (const pool of pools) {
      if (this.sweptPoolIds.has(pool.id)) {
        pool.isSwept = true;
        continue;
      }

      for (let k = pool.candleIndex + 1; k < n; k++) {
        const c = m15Candles[k];
        if (pool.type === 'BSL' && c.high > pool.price) {
          pool.isSwept = true;
          pool.sweptAt = c.time;
          break;
        }
        if (pool.type === 'SSL' && c.low < pool.price) {
          pool.isSwept = true;
          pool.sweptAt = c.time;
          break;
        }
      }
    }

    return pools;
  }

  /**
   * Kiểm tra điều kiện Cú Quét Thật (True Sweep Candle) trên 1 cây nến cụ thể đối với danh sách pool
   */
  detectSweepOnCandle(
    candle: CandleData,
    pools: LiquidityPool[],
    atr: number,
    expectedDirection?: 'BUY' | 'SELL',
  ): SweepSignal {
    const candleLength = candle.high - candle.low;
    if (candleLength <= 0 || atr <= 0) {
      return { hasSweep: false };
    }

    // Lọc các pool chưa từng bị quét trước thời điểm nến này
    const validPools = pools.filter((p) => {
      // Bỏ qua pool được tạo sau hoặc ngay tại thời điểm nến này
      if (p.time >= candle.time) return false;
      // Bỏ qua pool đã bị quét trước nến này (nếu sweptAt < candle.time)
      if (p.isSwept && p.sweptAt && p.sweptAt < candle.time) return false;
      // Nếu đã trong danh sách đã quét từ trước
      if (this.sweptPoolIds.has(p.id)) return false;
      return true;
    });

    let bestSweep: SweepSignal = { hasSweep: false };

    // 1. Quét đáy canh BUY (SSL Sweep)
    if (!expectedDirection || expectedDirection === 'BUY') {
      const sslPools = validPools.filter((p) => p.type === 'SSL');

      for (const pool of sslPools) {
        // Điều kiện 1: candle.low < SSL.price VÀ candle.close > SSL.price (đâm thủng nhưng rút râu đóng ngược lên trên)
        if (candle.low < pool.price && candle.close > pool.price) {
          const sweepDepth = pool.price - candle.low;
          const sweepDepthAtrRatio = sweepDepth / atr;

          // Điều kiện 2: Độ sâu quét hợp lệ: 0.1 * ATR(14) <= depth <= 1.5 * ATR(14)
          if (sweepDepthAtrRatio >= 0.1 && sweepDepthAtrRatio <= 1.5) {
            // Điều kiện 3: Tỷ lệ râu nến: Râu dưới chiếm ít nhất 40% tổng chiều dài cây nến
            const lowerWick = Math.min(candle.open, candle.close) - candle.low;
            const wickRatio = lowerWick / candleLength;

            if (wickRatio >= 0.4) {
              const suggestedSL = Number((candle.low - 0.2 * atr).toFixed(2));
              const currentCandidate: SweepSignal = {
                hasSweep: true,
                type: 'BUY_SWEEP',
                pool,
                sweepCandle: candle,
                sweepDepth: Number(sweepDepth.toFixed(2)),
                sweepDepthAtrRatio: Number(sweepDepthAtrRatio.toFixed(2)),
                wickRatio: Number(wickRatio.toFixed(2)),
                suggestedSL,
                description: `Quét Đáy (SSL Sweep -> Canh BUY) tại mốc $${pool.price}${pool.isMajorPool ? ' [EQL Bể lớn]' : ''}`,
              };

              // Ưu tiên Major Pool (EQL) hoặc độ sâu quét tối ưu
              if (
                !bestSweep.hasSweep ||
                (!bestSweep.pool?.isMajorPool && pool.isMajorPool) ||
                (bestSweep.pool?.isMajorPool === pool.isMajorPool &&
                  sweepDepth > (bestSweep.sweepDepth || 0))
              ) {
                bestSweep = currentCandidate;
              }
            }
          }
        }
      }
    }

    // 2. Quét đỉnh canh SELL (BSL Sweep)
    if (!expectedDirection || expectedDirection === 'SELL') {
      const bslPools = validPools.filter((p) => p.type === 'BSL');

      for (const pool of bslPools) {
        // Điều kiện 1: candle.high > BSL.price VÀ candle.close < BSL.price (đâm thủng nhưng rút râu đóng ngược xuống dưới)
        if (candle.high > pool.price && candle.close < pool.price) {
          const sweepDepth = candle.high - pool.price;
          const sweepDepthAtrRatio = sweepDepth / atr;

          // Điều kiện 2: Độ sâu quét hợp lệ: 0.1 * ATR(14) <= depth <= 1.5 * ATR(14)
          if (sweepDepthAtrRatio >= 0.1 && sweepDepthAtrRatio <= 1.5) {
            // Điều kiện 3: Tỷ lệ râu nến: Râu trên chiếm ít nhất 40% tổng chiều dài cây nến
            const upperWick = candle.high - Math.max(candle.open, candle.close);
            const wickRatio = upperWick / candleLength;

            if (wickRatio >= 0.4) {
              const suggestedSL = Number((candle.high + 0.2 * atr).toFixed(2));
              const currentCandidate: SweepSignal = {
                hasSweep: true,
                type: 'SELL_SWEEP',
                pool,
                sweepCandle: candle,
                sweepDepth: Number(sweepDepth.toFixed(2)),
                sweepDepthAtrRatio: Number(sweepDepthAtrRatio.toFixed(2)),
                wickRatio: Number(wickRatio.toFixed(2)),
                suggestedSL,
                description: `Quét Đỉnh (BSL Sweep -> Canh SELL) tại mốc $${pool.price}${pool.isMajorPool ? ' [EQH Bể lớn]' : ''}`,
              };

              // Ưu tiên Major Pool (EQH) hoặc độ sâu quét tối ưu
              if (
                !bestSweep.hasSweep ||
                (!bestSweep.pool?.isMajorPool && pool.isMajorPool) ||
                (bestSweep.pool?.isMajorPool === pool.isMajorPool &&
                  sweepDepth > (bestSweep.sweepDepth || 0))
              ) {
                bestSweep = currentCandidate;
              }
            }
          }
        }
      }
    }

    return bestSweep;
  }

  /**
   * Kiểm tra xem trên các nến gần nhất (nến hiện tại hoặc nến áp chót) có xảy ra cú Quét Thanh Khoản hợp lệ hay không
   * - recentCandles: danh sách nến của khung đang kiểm tra (ví dụ M5 cho BB+ATR, hoặc M15/H1 cho NWE+SMC)
   * - m15Candles: chuỗi nến M15 để lấy bể thanh khoản (Pivot High / Low)
   */
  checkRecentSweep(
    recentCandles: CandleData[],
    m15Candles: CandleData[],
    expectedDirection: 'BUY' | 'SELL',
    currentAtr?: number,
  ): SweepSignal {
    if (!recentCandles || recentCandles.length === 0 || !m15Candles || m15Candles.length === 0) {
      return { hasSweep: false };
    }

    const atr = currentAtr || this.calculateAtr(recentCandles, 14);
    const pools = this.identifyLiquidityPools(m15Candles, 5, 5, 100);

    // Kiểm tra nến hiện tại (nến mới nhất)
    const currentCandle = recentCandles[recentCandles.length - 1];
    const currentSweep = this.detectSweepOnCandle(currentCandle, pools, atr, expectedDirection);
    if (currentSweep.hasSweep) {
      return currentSweep;
    }

    // Nếu nến hiện tại chưa quét, kiểm tra nến áp chót (vừa đóng cửa)
    if (recentCandles.length >= 2) {
      const prevCandle = recentCandles[recentCandles.length - 2];
      const prevSweep = this.detectSweepOnCandle(prevCandle, pools, atr, expectedDirection);
      if (prevSweep.hasSweep) {
        return prevSweep;
      }
    }

    return { hasSweep: false };
  }

  /**
   * Đánh dấu 1 pool đã được xử lý để không phát cảnh báo lặp lại
   */
  markPoolAsSwept(poolId: string) {
    if (poolId) {
      this.sweptPoolIds.add(poolId);
      // Giới hạn kích thước cache để tránh rò rỉ bộ nhớ
      if (this.sweptPoolIds.size > 200) {
        const first = this.sweptPoolIds.values().next().value;
        if (first) this.sweptPoolIds.delete(first);
      }
    }
  }

  /**
   * Xóa toàn bộ pool đã swept (phục vụ unit test)
   */
  clearSweptPools() {
    this.sweptPoolIds.clear();
  }
}
