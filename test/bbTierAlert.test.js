const test = require('node:test');
const assert = require('node:assert/strict');

test('BB Tier Alert Classification Tests', async (t) => {
  // Mock logic matching BbAtrService
  function evaluateBbTier({ price, high, low, bbUpper, bbLower, atr, rsi, hasSweep }) {
    const upperEntry = bbUpper + atr;
    const lowerEntry = bbLower - atr;

    const isTouchUpper = price >= bbUpper || high >= bbUpper;
    const isTouchLower = price <= bbLower || low <= bbLower;
    const isEntrySell = price >= upperEntry || high >= upperEntry;
    const isEntryBuy = price <= lowerEntry || low <= lowerEntry;

    const isRsiOverbought = rsi >= 70;
    const isRsiOversold = rsi <= 30;

    let signal = 'NORMAL';
    let alertTier = 0;

    if (isEntrySell) {
      signal = 'ENTRY_SELL';
      alertTier = isRsiOverbought ? 2 : 1;
    } else if (isTouchUpper) {
      signal = isRsiOverbought ? 'SELL_CONFLUENCE' : 'TOUCH_UPPER_BB';
      alertTier = 0;
    } else if (isEntryBuy) {
      signal = 'ENTRY_BUY';
      alertTier = isRsiOversold ? 2 : 1;
    } else if (isTouchLower) {
      signal = isRsiOversold ? 'BUY_CONFLUENCE' : 'TOUCH_LOWER_BB';
      alertTier = 0;
    }

    if (hasSweep) {
      alertTier = 3;
    }

    return { signal, alertTier };
  }

  await t.test('1. Chạm dải BB thông thường (chưa chạm BB+ATR) -> alertTier = 0 (Normal alert 🔔)', () => {
    // Giá 3525 chạm dải Upper BB (3520), nhưng chưa tới Upper Entry (3520 + 10 = 3530)
    const res = evaluateBbTier({
      price: 3522,
      high: 3525,
      low: 3510,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 55,
      hasSweep: false,
    });
    assert.equal(res.signal, 'TOUCH_UPPER_BB');
    assert.equal(res.alertTier, 0);
  });

  await t.test('2. Khớp vùng Entry BB + ATR (Bands Upper + ATR) mà RSI chưa quá mua -> alertTier = 1 (🔥 1 đốm lửa)', () => {
    // Giá chạm 3532 >= Upper Entry (3530), RSI = 62 (< 70)
    const res = evaluateBbTier({
      price: 3532,
      high: 3533,
      low: 3510,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 62,
      hasSweep: false,
    });
    assert.equal(res.signal, 'ENTRY_SELL');
    assert.equal(res.alertTier, 1);
  });

  await t.test('3. Khớp vùng Entry BB + ATR VÀ RSI >= 70 -> alertTier = 2 (🔥🔥 2 đốm lửa)', () => {
    // Giá chạm 3532 >= Upper Entry (3530), RSI = 75 (>= 70)
    const res = evaluateBbTier({
      price: 3532,
      high: 3533,
      low: 3510,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 75,
      hasSweep: false,
    });
    assert.equal(res.signal, 'ENTRY_SELL');
    assert.equal(res.alertTier, 2);
  });

  await t.test('4. Khớp vùng Entry BUY (Bands Lower - ATR) VÀ RSI <= 30 -> alertTier = 2 (🔥🔥 2 đốm lửa)', () => {
    // Giá 3468 <= Lower Entry (3470 = 3480 - 10), RSI = 25 (<= 30)
    const res = evaluateBbTier({
      price: 3468,
      high: 3485,
      low: 3465,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 25,
      hasSweep: false,
    });
    assert.equal(res.signal, 'ENTRY_BUY');
    assert.equal(res.alertTier, 2);
  });

  await t.test('5. Có tín hiệu Quét Thanh Khoản (Liquidity Sweep) -> Nâng cấp lên alertTier = 3 (🔥🔥🔥 3 đốm lửa)', () => {
    const res = evaluateBbTier({
      price: 3532,
      high: 3535,
      low: 3510,
      bbUpper: 3520,
      bbLower: 3480,
      atr: 10,
      rsi: 78,
      hasSweep: true,
    });
    assert.equal(res.signal, 'ENTRY_SELL');
    assert.equal(res.alertTier, 3);
  });
});
