const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifySmcMtfTier,
  calculateWilderAtr,
  SMC_MTF_OB_TIMEFRAMES,
} = require('../dist/smc/smc-mtf-classifier');
const {
  detectZoneRejectionWick,
  M15_DURATION_MS,
} = require('../dist/indicator/signal-classifier');

const BASE_M15_MS = 1700001000000; // M15 candle open (ms)
const AT_60_PCT_M15 = BASE_M15_MS + Math.floor(0.6 * M15_DURATION_MS); // 9m00s (< 80% = 12m)
const AT_85_PCT_M15 = BASE_M15_MS + Math.floor(0.85 * M15_DURATION_MS); // 12m45s (>= 80% = 12m)

function makeCandle(time, open, high, low, close) {
  return { time, open, high, low, close, volume: 200 };
}

function makeNweH1(overrides = {}) {
  return {
    kernel: 3585.0,
    upperBand: 3615.44,
    lowerBand: 3554.56,
    mae: 10.15,
    dynamicResistance: 3620.0,
    dynamicSupport: 3550.0,
    isTouchUpper: false,
    isTouchLower: false,
    ...overrides,
  };
}

function makeOb(timeframe, type, bottom, top, time = BASE_M15_MS - 3600000) {
  return {
    id: `${type.toLowerCase()}_${timeframe}_${bottom}`,
    index: 10,
    time,
    top,
    bottom,
    type,
    label: `Vùng ${type === 'SUPPLY' ? 'Cung' : 'Cầu'} ${timeframe} (${type === 'SUPPLY' ? 'Bearish' : 'Bullish'} OB)`,
    timeframe,
    mitigated: false,
  };
}

test('SMC + NWE Cross-Timeframe Engine (NWE H1 + OB M15/M30/H1/H4 + Rút râu M15)', async (t) => {
  await t.test('1. Danh sách khung OB hợp lưu chuẩn xác là M15, M30, H1, H4 (bỏ qua M5 & D1)', () => {
    assert.deepEqual(SMC_MTF_OB_TIMEFRAMES, ['M15', 'M30', 'H1', 'H4']);

    const nweH1 = makeNweH1({ isTouchUpper: true });
    const obM5 = makeOb('M5', 'SUPPLY', 3615, 3625);
    const obD1 = makeOb('D1', 'SUPPLY', 3610, 3650);
    const m15Candle = makeCandle(BASE_M15_MS, 3614, 3618, 3613, 3617);

    const res = classifySmcMtfTier({
      currentPrice: 3617,
      candleHigh: 3618,
      candleLow: 3613,
      nweH1,
      obPools: [obM5, obD1],
      atrM15: 12,
      m15Candle,
      nowMs: AT_85_PCT_M15,
    });
    assert.equal(res.signal, 'NORMAL');
    assert.equal(res.alertTier, 0);
  });

  await t.test('2. Tier 2 (MTF Confluence): Chạm NWE H1 Upper + Supply OB M15 (chéo khung) -> alertTier = 2', () => {
    const nweH1 = makeNweH1({ isTouchUpper: true });
    const obM15 = makeOb('M15', 'SUPPLY', 3616.5, 3622.0);
    // Nến xanh tăng mạnh vào vùng OB, chưa rút râu
    const m15Candle = makeCandle(BASE_M15_MS, 3612.0, 3619.0, 3611.5, 3618.5);

    const res = classifySmcMtfTier({
      currentPrice: 3618.5,
      candleHigh: 3619.0,
      candleLow: 3611.5,
      nweH1,
      obPools: [obM15],
      atrM15: 12,
      m15Candle,
      nowMs: AT_85_PCT_M15,
    });
    assert.equal(res.signal, 'CONFLUENCE_SELL');
    assert.equal(res.alertTier, 2);
    assert.equal(res.tierReason, 'SMC_TIER_2_MTF_CONFLUENCE');
    assert.equal(res.matchedOrderBlocks.length, 1);
    assert.equal(res.primaryOb.timeframe, 'M15');
    assert.equal(res.confluenceLevel, 3616.5);
  });

  await t.test('3. Tier 2 đa khung: NWE H1 Lower + giao cắt đồng thời Demand OB M15 & H1 -> ưu tiên H1 làm primaryOb', () => {
    const nweH1 = makeNweH1({ isTouchLower: true });
    const obM15 = makeOb('M15', 'DEMAND', 3546.0, 3553.0);
    const obH1 = makeOb('H1', 'DEMAND', 3540.0, 3555.0);
    const m15Candle = makeCandle(BASE_M15_MS, 3558.0, 3558.5, 3551.0, 3551.5);

    const res = classifySmcMtfTier({
      currentPrice: 3551.5,
      candleHigh: 3558.5,
      candleLow: 3551.0,
      nweH1,
      obPools: [obM15, obH1],
      atrM15: 12,
      m15Candle,
      nowMs: AT_85_PCT_M15,
    });
    assert.equal(res.signal, 'CONFLUENCE_BUY');
    assert.equal(res.alertTier, 2);
    assert.equal(res.tierReason, 'SMC_TIER_2_MTF_CONFLUENCE');
    assert.equal(res.matchedOrderBlocks.length, 2);
    assert.equal(res.primaryOb.timeframe, 'H1');
    assert.equal(res.confluenceLevel, 3554.56); // min(3554.56, 3555.0)
  });

  await t.test('4. Chỉ chạm OB M15 nhưng CHƯA chạm biên NWE H1 -> trả về NORMAL', () => {
    const nweH1 = makeNweH1({ upperBand: 3625.0, isTouchUpper: false });
    const obM15 = makeOb('M15', 'SUPPLY', 3610.0, 3618.0);
    const m15Candle = makeCandle(BASE_M15_MS, 3608.0, 3615.0, 3607.0, 3614.0);

    const res = classifySmcMtfTier({
      currentPrice: 3614.0,
      candleHigh: 3615.0,
      candleLow: 3607.0,
      nweH1,
      obPools: [obM15],
      atrM15: 12,
      m15Candle,
      nowMs: AT_85_PCT_M15,
    });
    assert.equal(res.signal, 'NORMAL');
    assert.equal(res.alertTier, 0);
  });

  await t.test('5. Tier 3 (VIP) — Rút râu M15 BÊN TRONG lòng OB rộng (H1: 3616 - 3632), cả Dạng A (Pinbar) & Dạng B (thuận màu)', () => {
    const nweH1 = makeNweH1({ upperBand: 3615.44, isTouchUpper: true });
    const wideObH1 = makeOb('H1', 'SUPPLY', 3616.0, 3632.0); // OB rộng 16 giá
    const atrM15 = 12.0; // min totalRange = 6.0, min wick = 3.0

    // Case 5A: Dạng A (Pinbar xanh đóng BÊN TRONG lòng OB tại 3620 > ob.bottom 3616, nhưng < ob.top 3632)
    // totalRange = 3629 - 3618 = 11 (>= 6), upperWick = 3629 - 3620 = 9 (81.8% >= 45%, >= 3.0)
    // closePos = (3620 - 3618) / 11 = 18.2% (<= 45%)
    const insideObPinbar = makeCandle(BASE_M15_MS, 3619.0, 3629.0, 3618.0, 3620.0);
    assert.equal(detectZoneRejectionWick(insideObPinbar, 3616.0, 3632.0, atrM15, 'SELL'), true);

    const resTier3A = classifySmcMtfTier({
      currentPrice: insideObPinbar.close,
      candleHigh: insideObPinbar.high,
      candleLow: insideObPinbar.low,
      nweH1,
      obPools: [wideObH1],
      atrM15,
      m15Candle: insideObPinbar,
      nowMs: AT_85_PCT_M15,
    });
    assert.equal(resTier3A.signal, 'CONFLUENCE_SELL');
    assert.equal(resTier3A.alertTier, 3);
    assert.equal(resTier3A.tierReason, 'SMC_TIER_3_MTF_WICK');
    assert.equal(resTier3A.primaryOb.timeframe, 'H1');
    assert.equal(resTier3A.rejectionCandleTime, BASE_M15_MS);

    // Case 5B: Dạng B (Nến đỏ đảo chiều thuận màu trong lòng OB, râu = 35.7% >= 25% & < 45%)
    // open = 3625, high = 3630, low = 3616, close = 3618 (nằm trong [3616, 3632])
    // totalRange = 14 (>= 6), upperWick = 5 (>= 3, 35.7%), closePos = 2/14 = 14.3% (<= 45%)
    const insideObRedReversal = makeCandle(BASE_M15_MS, 3625.0, 3630.0, 3616.0, 3618.0);
    assert.equal(detectZoneRejectionWick(insideObRedReversal, 3616.0, 3632.0, atrM15, 'SELL'), true);

    const resTier3B = classifySmcMtfTier({
      currentPrice: insideObRedReversal.close,
      candleHigh: insideObRedReversal.high,
      candleLow: insideObRedReversal.low,
      nweH1,
      obPools: [wideObH1],
      atrM15,
      m15Candle: insideObRedReversal,
      nowMs: AT_85_PCT_M15,
    });
    assert.equal(resTier3B.alertTier, 3);
    assert.equal(resTier3B.tierReason, 'SMC_TIER_3_MTF_WICK');
  });

  await t.test('6. Case phá vỡ mép OB (close >= ob.top với SELL / close <= ob.bottom với BUY) -> detectZoneRejectionWick trả về false', () => {
    const atrM15 = 12.0;

    // SELL: OB [3616 - 3630], nến rút râu từ 3642 nhưng vẫn đóng TẠI/TRÊN ob.top (3631 >= 3630) -> PHÁ VỠ OB!
    const brokenSupplyCandle = makeCandle(BASE_M15_MS, 3630.0, 3642.0, 3629.0, 3631.0);
    assert.equal(detectZoneRejectionWick(brokenSupplyCandle, 3616.0, 3630.0, atrM15, 'SELL'), false);

    // BUY: OB [3540 - 3554], nến rút chân từ 3528 nhưng vẫn đóng DƯỚI ob.bottom (3539 <= 3540) -> PHÁ VỠ OB!
    const brokenDemandCandle = makeCandle(BASE_M15_MS, 3541.0, 3542.0, 3528.0, 3539.0);
    assert.equal(detectZoneRejectionWick(brokenDemandCandle, 3554.0, 3540.0, atrM15, 'BUY'), false);
  });

  await t.test('7. Chống rút râu ảo đầu nến M15 (< 80% = < 12 phút) & chuẩn hóa Unix seconds + bắt Tier 3 từ m15PrevCandle', () => {
    const nweH1 = makeNweH1({ lowerBand: 3554.56, isTouchLower: true });
    const obH4 = makeOb('H4', 'DEMAND', 3540.0, 3556.0);
    const atrM15 = 12.0;
    const baseSec = Math.floor(BASE_M15_MS / 1000);

    // Nến M15 Pinbar BUY đẹp trong lòng OB H4 (low = 3542, close = 3552 > ob.bottom 3540)
    // totalRange = 12 (>= 6), lowerWick = 3550 - 3542 = 8 (66.7% >= 45%), closePos = 10/12 = 83.3% (>= 55%)
    const buyPinbarSec = makeCandle(baseSec, 3550.0, 3554.0, 3542.0, 3552.0);

    // Mới qua phút thứ 9 (60% < 80%) -> KHÔNG lên Tier 3, chỉ báo Tier 2 MTF
    const earlyRes = classifySmcMtfTier({
      currentPrice: buyPinbarSec.close,
      candleHigh: buyPinbarSec.high,
      candleLow: buyPinbarSec.low,
      nweH1,
      obPools: [obH4],
      atrM15,
      m15Candle: buyPinbarSec,
      nowMs: AT_60_PCT_M15,
    });
    assert.equal(earlyRes.alertTier, 2);
    assert.equal(earlyRes.tierReason, 'SMC_TIER_2_MTF_CONFLUENCE');

    // Qua phút 12:45 (85% >= 80%) -> Lên Tier 3 & chuẩn hóa rejectionCandleTime sang ms
    const lateRes = classifySmcMtfTier({
      currentPrice: buyPinbarSec.close,
      candleHigh: buyPinbarSec.high,
      candleLow: buyPinbarSec.low,
      nweH1,
      obPools: [obH4],
      atrM15,
      m15Candle: buyPinbarSec,
      nowMs: AT_85_PCT_M15,
    });
    assert.equal(lateRes.alertTier, 3);
    assert.equal(lateRes.tierReason, 'SMC_TIER_3_MTF_WICK');
    assert.equal(lateRes.rejectionCandleTime, baseSec * 1000);

    // Đầu nến M15 kế tiếp (elapsed = 10s < 80%), giá đã bật lên 3562 rời khỏi NWE H1 Lower (3554.56)
    // Vẫn phải bắt được Tier 3 từ m15PrevCandle!
    const nextM15Open = BASE_M15_MS + M15_DURATION_MS;
    const nextM15Bar = makeCandle(nextM15Open, 3558.0, 3563.0, 3557.0, 3562.0);
    const prevRes = classifySmcMtfTier({
      currentPrice: nextM15Bar.close,
      candleHigh: nextM15Bar.high,
      candleLow: nextM15Bar.low,
      nweH1: makeNweH1({ lowerBand: 3554.56, isTouchLower: false }),
      obPools: [obH4],
      atrM15,
      m15Candle: nextM15Bar,
      m15PrevCandle: buyPinbarSec,
      nowMs: nextM15Open + 10000,
    });
    assert.equal(prevRes.signal, 'CONFLUENCE_BUY');
    assert.equal(prevRes.alertTier, 3);
    assert.equal(prevRes.tierReason, 'SMC_TIER_3_MTF_WICK');
    assert.equal(prevRes.rejectionCandleTime, baseSec * 1000);
  });

  await t.test('8. Lọc nhiễu theo atrM15: Doji nhỏ (< 0.5 ATR M15) & bẫy trượt biên không được nâng lên Tier 3', () => {
    const nweH1 = makeNweH1({ upperBand: 3615.44, isTouchUpper: true });
    const obH1 = makeOb('H1', 'SUPPLY', 3616.0, 3630.0);
    const atrM15 = 14.0; // min totalRange = 7.0

    // Doji nhỏ có totalRange = 5.0 (< 7.0 = 0.5 * atrM15) -> phải bị lọc, chỉ giữ Tier 2
    const tinyDoji = makeCandle(BASE_M15_MS, 3617.0, 3621.0, 3616.0, 3616.5);
    assert.equal(detectZoneRejectionWick(tinyDoji, 3616.0, 3630.0, atrM15, 'SELL'), false);

    const resDoji = classifySmcMtfTier({
      currentPrice: tinyDoji.close,
      candleHigh: tinyDoji.high,
      candleLow: tinyDoji.low,
      nweH1,
      obPools: [obH1],
      atrM15,
      m15Candle: tinyDoji,
      nowMs: AT_85_PCT_M15,
    });
    assert.equal(resDoji.alertTier, 2);
    assert.equal(resDoji.tierReason, 'SMC_TIER_2_MTF_CONFLUENCE');

    // Bẫy trượt biên BUY: Nến đỏ đóng sát đáy (closePos = 25% < 55%) -> false
    const slidingTrapBuy = makeCandle(BASE_M15_MS, 3556.0, 3557.0, 3541.0, 3545.0);
    assert.equal(detectZoneRejectionWick(slidingTrapBuy, 3554.56, 3540.0, atrM15, 'BUY'), false);
  });

  await t.test('9. calculateWilderAtr tính chuẩn ATR(14) khung M15', () => {
    const m15Candles = [];
    for (let i = 0; i < 25; i++) {
      m15Candles.push(makeCandle(BASE_M15_MS + i * M15_DURATION_MS, 3600, 3612, 3600, 3606));
    }
    assert.equal(calculateWilderAtr(m15Candles, 14), 12);
  });

  await t.test('10. SmcService.calculateNwe khớp chuẩn Pine Script (tính y2[i] riêng từng nến trên 500 nến, không phình MAE khi trend mạnh)', () => {
    const { SmcService } = require('../dist/smc/smc.service');
    const svc = Object.create(SmcService.prototype);

    // Tạo chuỗi 500 nến giảm dốc tuyến tính từ 3900 xuống 3401 (-1$/nến)
    // Với Pine Script chuẩn: y2[i] bám sát đường thẳng nên MAE gần bằng ~0 (chỉ lệch nhẹ ở 2 đầu mút)
    // Code cũ so mọi nến với kernelValue cuối sẽ ra MAE khổng lồ (~25$ -> band ~75$!)
    const trendCandles = [];
    for (let i = 0; i < 500; i++) {
      const p = 3900 - i;
      trendCandles.push(makeCandle(BASE_M15_MS + i * 3600000, p + 0.5, p + 1, p - 1, p));
    }

    const nwe = svc.calculateNwe(trendCandles, 8, 3.0);
    assert.ok(nwe.mae < 1.0, `MAE trên chuỗi tuyến tính phải rất nhỏ (< 1.0), thực tế: ${nwe.mae}`);
    assert.ok(
      nwe.upperBand - nwe.kernel < 3.0,
      `Biên trên phải bám sát đường cong (< 3.0), thực tế: ${nwe.upperBand - nwe.kernel}`,
    );
  });
});
