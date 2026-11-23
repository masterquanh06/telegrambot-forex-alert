const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifySignalTier,
  detectM5RejectionWick,
  M5_DURATION_MS,
} = require('../dist/indicator/signal-classifier');

const BASE_TIME_MS = 1700000100000; // Mock candle open timestamp (ms)
const AT_85_PCT_MS = BASE_TIME_MS + Math.floor(0.85 * M5_DURATION_MS); // 4m15s (>= 80%)
const AT_40_PCT_MS = BASE_TIME_MS + Math.floor(0.4 * M5_DURATION_MS); // 2m00s (< 80%)

function makeCandle(time, open, high, low, close) {
  return { time, open, high, low, close, volume: 100 };
}

test('Pure Signal Engine — detectM5RejectionWick & classifySignalTier', async (t) => {
  await t.test('1. Tier 0: Chạm dải BB thông thường (chưa chạm BB±ATR, không rút râu) -> alertTier = 0', () => {
    const candle = makeCandle(BASE_TIME_MS, 3510, 3525, 3510, 3524);
    const res = classifySignalTier({
      price: 3524,
      high: 3525,
      low: 3510,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 55,
      candle,
      nowMs: AT_85_PCT_MS,
    });
    assert.equal(res.signal, 'TOUCH_UPPER_BB');
    assert.equal(res.alertTier, 0);
    assert.equal(res.tierReason, 'TIER_0_BB_TOUCH');
  });

  await t.test('2. Tier 1: Khớp vùng Entry BB ± ATR, RSI trung tính, không rút râu -> alertTier = 1', () => {
    const candle = makeCandle(BASE_TIME_MS, 3515, 3533, 3515, 3532);
    const res = classifySignalTier({
      price: 3532,
      high: 3533,
      low: 3515,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 62,
      candle,
      nowMs: AT_85_PCT_MS,
    });
    assert.equal(res.signal, 'ENTRY_SELL');
    assert.equal(res.alertTier, 1);
    assert.equal(res.tierReason, 'TIER_1_BB_ATR');
  });

  await t.test('3. Tier 2A: Khớp BB Upper + ATR & RSI >= 70 (SELL) và BB Lower - ATR & RSI <= 30 (BUY)', () => {
    // SELL Tier 2A
    const sellCandle = makeCandle(BASE_TIME_MS, 3515, 3533, 3515, 3532);
    const resSell = classifySignalTier({
      price: 3532,
      high: 3533,
      low: 3515,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 75,
      candle: sellCandle,
      nowMs: AT_85_PCT_MS,
    });
    assert.equal(resSell.signal, 'ENTRY_SELL');
    assert.equal(resSell.alertTier, 2);
    assert.equal(resSell.tierReason, 'TIER_2A_RSI');

    // BUY Tier 2A
    const buyCandle = makeCandle(BASE_TIME_MS, 3485, 3485, 3465, 3468);
    const resBuy = classifySignalTier({
      price: 3468,
      high: 3485,
      low: 3465,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 25,
      candle: buyCandle,
      nowMs: AT_85_PCT_MS,
    });
    assert.equal(resBuy.signal, 'ENTRY_BUY');
    assert.equal(resBuy.alertTier, 2);
    assert.equal(resBuy.tierReason, 'TIER_2A_RSI');
  });

  await t.test('4. Tier 2B — Dạng A (Pinbar bất kể màu) ngay tại dải BB Upper / BB Lower', () => {
    // BUY: Nến ĐỎ Pinbar đâm thủng BB Lower (3480) nhưng chưa chạm BB Lower - ATR (3470)
    // totalRange = 3489 - 3475 = 14 (>= 5 = 0.5*ATR)
    // lowerWick = min(3488, 3486) - 3475 = 11 (>= 2.5 = 0.25*ATR)
    // lowerWick / totalRange = 11/14 = 78.6% (>= 45% -> Dạng A)
    // closePos = (3486 - 3475) / 14 = 78.6% (>= 55%)
    const redPinbarBuy = makeCandle(BASE_TIME_MS, 3488, 3489, 3475, 3486);
    assert.equal(detectM5RejectionWick(redPinbarBuy, 3480, 10, 'BUY'), true);

    const resBuy = classifySignalTier({
      price: redPinbarBuy.close,
      high: redPinbarBuy.high,
      low: redPinbarBuy.low,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 42,
      candle: redPinbarBuy,
      nowMs: AT_85_PCT_MS,
    });
    assert.equal(resBuy.signal, 'BUY_CONFLUENCE');
    assert.equal(resBuy.alertTier, 2);
    assert.equal(resBuy.tierReason, 'TIER_2B_M5_WICK');
    assert.equal(resBuy.rejectionCandleTime, BASE_TIME_MS);

    // SELL: Nến XANH Pinbar đâm vượt BB Upper (3520), chưa chạm BB Upper + ATR (3530)
    // totalRange = 3526 - 3512 = 14 (>= 5)
    // upperWick = 3526 - max(3513, 3515) = 11 (>= 2.5), ratio = 78.6% (>= 45%)
    // closePos = (3515 - 3512) / 14 = 21.4% (<= 45%)
    const greenPinbarSell = makeCandle(BASE_TIME_MS, 3513, 3526, 3512, 3515);
    assert.equal(detectM5RejectionWick(greenPinbarSell, 3520, 10, 'SELL'), true);

    const resSell = classifySignalTier({
      price: greenPinbarSell.close,
      high: greenPinbarSell.high,
      low: greenPinbarSell.low,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 58,
      candle: greenPinbarSell,
      nowMs: AT_85_PCT_MS,
    });
    assert.equal(resSell.signal, 'SELL_CONFLUENCE');
    assert.equal(resSell.alertTier, 2);
    assert.equal(resSell.tierReason, 'TIER_2B_M5_WICK');
  });

  await t.test('5. Tier 2B — Dạng B (Nến đảo chiều thuận màu, râu >= 25% và < 45%) tại dải BB', () => {
    // BUY: Nến XANH đảo chiều thuận màu đâm BB Lower (3480), chưa chạm 3470
    // open = 3481, high = 3490, low = 3476, close = 3489
    // totalRange = 14 (>= 5), lowerWick = 3481 - 3476 = 5 (>= 2.5)
    // lowerWick / totalRange = 5/14 = 35.7% (không đạt Pinbar 45%, nhưng >= 25% và close > open -> Dạng B)
    // closePos = (3489 - 3476) / 14 = 92.8% (>= 55%)
    const greenReversalBuy = makeCandle(BASE_TIME_MS, 3481, 3490, 3476, 3489);
    assert.equal(detectM5RejectionWick(greenReversalBuy, 3480, 10, 'BUY'), true);

    const resBuy = classifySignalTier({
      price: greenReversalBuy.close,
      high: greenReversalBuy.high,
      low: greenReversalBuy.low,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 45,
      candle: greenReversalBuy,
      nowMs: AT_85_PCT_MS,
    });
    assert.equal(resBuy.signal, 'BUY_CONFLUENCE');
    assert.equal(resBuy.alertTier, 2);
    assert.equal(resBuy.tierReason, 'TIER_2B_M5_WICK');

    // SELL: Nến ĐỎ đảo chiều thuận màu đâm BB Upper (3520), chưa chạm 3530
    // open = 3519, high = 3524, low = 3510, close = 3511
    // totalRange = 14 (>= 5), upperWick = 3524 - 3519 = 5 (>= 2.5)
    // upperWick / totalRange = 5/14 = 35.7% (< 45%, nhưng >= 25% và close < open -> Dạng B)
    // closePos = (3511 - 3510) / 14 = 7.1% (<= 45%)
    const redReversalSell = makeCandle(BASE_TIME_MS, 3519, 3524, 3510, 3511);
    assert.equal(detectM5RejectionWick(redReversalSell, 3520, 10, 'SELL'), true);

    const resSell = classifySignalTier({
      price: redReversalSell.close,
      high: redReversalSell.high,
      low: redReversalSell.low,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 55,
      candle: redReversalSell,
      nowMs: AT_85_PCT_MS,
    });
    assert.equal(resSell.signal, 'SELL_CONFLUENCE');
    assert.equal(resSell.alertTier, 2);
    assert.equal(resSell.tierReason, 'TIER_2B_M5_WICK');
  });

  await t.test('6. Case bẫy trượt biên: Nến đỏ đâm BB Lower nhưng đóng sát biên -> phải trả về false', () => {
    // open = 3492, high = 3492, low = 3476, close = 3481 (đâm qua BB Lower 3480 nhưng đóng sát biên)
    // totalRange = 16 (>= 5), lowerWick = 3481 - 3476 = 5 (>= 2.5)
    // closePos = (3481 - 3476) / 16 = 31.25% (< 55% -> FAIL!)
    // lowerWick / totalRange = 31.25% (< 45% và là nến đỏ close < open -> FAIL!)
    const slidingTrapCandle = makeCandle(BASE_TIME_MS, 3492, 3492, 3476, 3481);
    assert.equal(detectM5RejectionWick(slidingTrapCandle, 3480, 10, 'BUY'), false);

    const res = classifySignalTier({
      price: slidingTrapCandle.close,
      high: slidingTrapCandle.high,
      low: slidingTrapCandle.low,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 38,
      candle: slidingTrapCandle,
      nowMs: AT_85_PCT_MS,
    });
    assert.equal(res.alertTier, 0);
    assert.equal(res.signal, 'TOUCH_LOWER_BB');
  });

  await t.test('7. Case Doji nhiễu nhỏ hơn 0.5 ATR -> phải trả về false', () => {
    // ATR = 10 -> ngưỡng lọc nhiễu tối thiểu = 5.0
    // Doji có totalRange = 3522 - 3518 = 4.0 (< 5.0) dù có râu trên chiếm 75%
    const tinyDoji = makeCandle(BASE_TIME_MS, 3518.5, 3522, 3518, 3518.2);
    assert.equal(detectM5RejectionWick(tinyDoji, 3520, 10, 'SELL'), false);

    const res = classifySignalTier({
      price: tinyDoji.close,
      high: tinyDoji.high,
      low: tinyDoji.low,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 55,
      candle: tinyDoji,
      nowMs: AT_85_PCT_MS,
    });
    assert.equal(res.alertTier, 0);
    assert.equal(res.signal, 'TOUCH_UPPER_BB');
  });

  await t.test('8. Chống rút râu ảo đầu nến (< 80% thời gian) & chuẩn hóa timestamp Unix seconds', () => {
    const baseTimeSec = Math.floor(BASE_TIME_MS / 1000); // Unix seconds (như TradingView WS)
    const pinbarInSec = makeCandle(baseTimeSec, 3488, 3489, 3475, 3486);

    // Mới qua 40% thời gian nến M5 (phút thứ 2) -> KHÔNG kích hoạt Tier 2B
    const earlyRes = classifySignalTier({
      price: pinbarInSec.close,
      high: pinbarInSec.high,
      low: pinbarInSec.low,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 45,
      candle: pinbarInSec,
      nowMs: AT_40_PCT_MS,
    });
    assert.equal(earlyRes.alertTier, 0);
    assert.equal(earlyRes.tierReason, 'TIER_0_BB_TOUCH');

    // Qua 85% thời gian nến M5 (phút 4:15) -> kích hoạt Tier 2B & chuẩn hóa rejectionCandleTime sang ms
    const lateRes = classifySignalTier({
      price: pinbarInSec.close,
      high: pinbarInSec.high,
      low: pinbarInSec.low,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 45,
      candle: pinbarInSec,
      nowMs: AT_85_PCT_MS,
    });
    assert.equal(lateRes.alertTier, 2);
    assert.equal(lateRes.tierReason, 'TIER_2B_M5_WICK');
    assert.equal(lateRes.rejectionCandleTime, baseTimeSec * 1000);
  });

  await t.test('9. Tier 3 (VIP): Nến rút râu M5 tại mốc BB ± ATR (cả cuối nến hiện tại lẫn đầu nến mới từ prevCandle)', () => {
    // Upper Entry = 3520 + 10 = 3530
    // Nến M5 đâm vượt 3530 lên 3536, rút râu đóng tại 3525 (< 3530)
    // totalRange = 3536 - 3524 = 12 (>= 5), upperWick = 3536 - 3527 = 9 (>= 2.5, 75% >= 45%)
    // closePos = (3525 - 3524) / 12 = 8.3% (<= 45%)
    const tier3SellCandle = makeCandle(BASE_TIME_MS, 3527, 3536, 3524, 3525);
    assert.equal(detectM5RejectionWick(tier3SellCandle, 3530, 10, 'SELL'), true);

    // Trường hợp A: Phát hiện ở cuối nến hiện tại (>= 80%)
    const resCurrent = classifySignalTier({
      price: tier3SellCandle.close,
      high: tier3SellCandle.high,
      low: tier3SellCandle.low,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 68,
      candle: tier3SellCandle,
      nowMs: AT_85_PCT_MS,
    });
    assert.equal(resCurrent.signal, 'ENTRY_SELL');
    assert.equal(resCurrent.alertTier, 3);
    assert.equal(resCurrent.tierReason, 'TIER_3_M5_WICK');
    assert.equal(resCurrent.rejectionCandleTime, BASE_TIME_MS);

    // Trường hợp B: Vừa mở nến mới (elapsed < 80%), giá nến mới đã rút về 3522 (< upperEntry 3530),
    // isEntrySell của nến mới = false nhưng vẫn phải bắt được Tier 3 từ prevCandle!
    const nextBarTime = BASE_TIME_MS + M5_DURATION_MS;
    const newBarCandle = makeCandle(nextBarTime, 3525, 3525.5, 3521, 3522);
    const resFromPrev = classifySignalTier({
      price: newBarCandle.close,
      high: newBarCandle.high,
      low: newBarCandle.low,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 60,
      candle: newBarCandle,
      prevCandle: tier3SellCandle,
      nowMs: nextBarTime + 5000, // mới mở nến 5 giây (< 80%)
    });
    assert.equal(resFromPrev.signal, 'ENTRY_SELL');
    assert.equal(resFromPrev.alertTier, 3);
    assert.equal(resFromPrev.tierReason, 'TIER_3_M5_WICK');
    assert.equal(resFromPrev.rejectionCandleTime, BASE_TIME_MS);

    // Trường hợp C: Tier 3 chiều BUY tại Lower Entry = 3480 - 10 = 3470
    // Nến đâm thủng 3470 xuống 3464, rút râu đóng 3474 (> 3470)
    const tier3BuyCandle = makeCandle(BASE_TIME_MS, 3472, 3475, 3464, 3474);
    assert.equal(detectM5RejectionWick(tier3BuyCandle, 3470, 10, 'BUY'), true);

    const resBuyTier3 = classifySignalTier({
      price: tier3BuyCandle.close,
      high: tier3BuyCandle.high,
      low: tier3BuyCandle.low,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 35,
      candle: tier3BuyCandle,
      isCandleClosed: true,
    });
    assert.equal(resBuyTier3.signal, 'ENTRY_BUY');
    assert.equal(resBuyTier3.alertTier, 3);
    assert.equal(resBuyTier3.tierReason, 'TIER_3_M5_WICK');
  });
});
