const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { LiquiditySweepService } = require('../dist/services/liquiditySweep');

describe('LiquiditySweepService Unit Tests', () => {
  let service;

  beforeEach(() => {
    service = new LiquiditySweepService();
    service.clearSweptPools();
  });

  // Helper tạo nến mẫu
  function createCandle(time, open, high, low, close) {
    return { time, open, high, low, close, volume: 100 };
  }

  it('1. Tính ATR(14) chuẩn xác', () => {
    const candles = [];
    for (let i = 0; i < 20; i++) {
      candles.push(createCandle(i * 900000, 2000, 2010, 1990, 2005));
    }
    const atr = service.calculateAtr(candles, 14);
    assert.ok(atr > 0, 'ATR phải lớn hơn 0');
    assert.strictEqual(atr, 20); // Vì high - low luôn bằng 20
  });

  it('2. Xác định Pivot High (BSL) và Pivot Low (SSL) với left = 5, right = 5', () => {
    const candles = [];
    const baseTime = 1700000000000;

    // 5 nến tăng dần trước đỉnh
    for (let i = 0; i < 5; i++) {
      candles.push(createCandle(baseTime + i * 900000, 2000 + i * 2, 2005 + i * 2, 1995 + i * 2, 2002 + i * 2));
    }
    // Nến đỉnh số 5 (index = 5) có High = 2030 (cao nhất)
    candles.push(createCandle(baseTime + 5 * 900000, 2015, 2030, 2010, 2020));

    // 5 nến giảm dần sau đỉnh
    for (let i = 6; i <= 10; i++) {
      candles.push(createCandle(baseTime + i * 900000, 2025 - (i - 5) * 2, 2028 - (i - 5) * 2, 2015 - (i - 5) * 2, 2020 - (i - 5) * 2));
    }

    const pools = service.identifyLiquidityPools(candles, 5, 5, 50);
    const bsl = pools.find((p) => p.type === 'BSL');

    assert.ok(bsl, 'Phải tìm thấy BSL pool');
    assert.strictEqual(bsl.price, 2030, 'Giá đỉnh BSL phải là 2030');
    assert.strictEqual(bsl.candleIndex, 5, 'Index nến đỉnh phải là 5');
    assert.strictEqual(bsl.isSwept, false, 'Chưa bị quét');
  });

  it('3. Nhận diện Equal Highs (EQH) và gắn cờ isMajorPool = true khi chênh lệch <= 0.2 * ATR', () => {
    const candles = [];
    const baseTime = 1700000000000;

    // Tạo chuỗi nến có 2 đỉnh Pivot High gần nhau tại 2050.0 và 2050.5
    // Đỉnh 1 tại index 5 (High = 2050.0)
    for (let i = 0; i < 5; i++) candles.push(createCandle(baseTime + i * 900000, 2030, 2040, 2020, 2035));
    candles.push(createCandle(baseTime + 5 * 900000, 2045, 2050.0, 2040, 2045));
    for (let i = 6; i <= 10; i++) candles.push(createCandle(baseTime + i * 900000, 2030, 2040, 2020, 2035));

    // Đỉnh 2 tại index 16 (High = 2050.5)
    for (let i = 11; i < 16; i++) candles.push(createCandle(baseTime + i * 900000, 2030, 2040, 2020, 2035));
    candles.push(createCandle(baseTime + 16 * 900000, 2045, 2050.5, 2040, 2045));
    for (let i = 17; i <= 21; i++) candles.push(createCandle(baseTime + i * 900000, 2030, 2040, 2020, 2035));

    const pools = service.identifyLiquidityPools(candles, 5, 5, 50);
    const bslPools = pools.filter((p) => p.type === 'BSL');

    assert.strictEqual(bslPools.length, 2, 'Phải có 2 BSL pools');
    assert.strictEqual(bslPools[0].isMajorPool, true, 'Đỉnh 1 phải được gắn cờ isMajorPool = true');
    assert.strictEqual(bslPools[1].isMajorPool, true, 'Đỉnh 2 phải được gắn cờ isMajorPool = true');
  });

  it('4. Quản lý vòng đời Pool: Đánh dấu isSwept = true khi nến sau phá qua', () => {
    const candles = [];
    const baseTime = 1700000000000;

    // Đỉnh tại index 5 có High = 2050
    for (let i = 0; i < 5; i++) candles.push(createCandle(baseTime + i * 900000, 2030, 2040, 2020, 2035));
    candles.push(createCandle(baseTime + 5 * 900000, 2045, 2050, 2040, 2045));
    for (let i = 6; i <= 10; i++) candles.push(createCandle(baseTime + i * 900000, 2030, 2040, 2020, 2035));

    // Nến tại index 11 đâm lên 2060 (phá đỉnh 2050)
    candles.push(createCandle(baseTime + 11 * 900000, 2040, 2060, 2035, 2045));

    const pools = service.identifyLiquidityPools(candles, 5, 5, 50);
    const bsl = pools.find((p) => p.type === 'BSL');

    assert.ok(bsl, 'Phải có BSL');
    assert.strictEqual(bsl.isSwept, true, 'Pool phải bị đánh dấu isSwept = true vì nến index 11 đã phá đỉnh');
  });

  it('5. Xác nhận Cú Quét Đáy Thật (SSL Sweep -> Canh BUY)', () => {
    const atr = 10.0;
    const sslPool = {
      id: 'SSL_1',
      type: 'SSL',
      price: 2000.0,
      time: 1700000000000,
      timeStr: '10:00',
      candleIndex: 5,
      isMajorPool: true,
      isSwept: false,
    };

    // Nến quét đáy:
    // Low = 1996.0 (quét qua 2000 sâu 4.0 điểm = 0.4 ATR -> hợp lệ [0.1 ATR - 1.5 ATR])
    // Close = 2008.0 (đóng ngược lên trên 2000)
    // High = 2010.0
    // Open = 2005.0
    // Candle length = 2010 - 1996 = 14
    // Lower wick = min(2005, 2008) - 1996 = 2005 - 1996 = 9 -> wick ratio = 9/14 = 64.3% >= 40%
    const sweepCandle = createCandle(1700009000000, 2005.0, 2010.0, 1996.0, 2008.0);

    const signal = service.detectSweepOnCandle(sweepCandle, [sslPool], atr, 'BUY');

    assert.strictEqual(signal.hasSweep, true, 'Phải phát hiện SSL Sweep');
    assert.strictEqual(signal.type, 'BUY_SWEEP');
    assert.strictEqual(signal.sweepDepth, 4.0);
    assert.strictEqual(signal.sweepDepthAtrRatio, 0.4);
    assert.ok(signal.wickRatio >= 0.4, 'Tỷ lệ râu dưới >= 40%');
    // Suggested SL = candle.low - 0.2 * atr = 1996 - 2 = 1994
    assert.strictEqual(signal.suggestedSL, 1994.0);
  });

  it('6. Xác nhận Cú Quét Đỉnh Thật (BSL Sweep -> Canh SELL)', () => {
    const atr = 10.0;
    const bslPool = {
      id: 'BSL_1',
      type: 'BSL',
      price: 2050.0,
      time: 1700000000000,
      timeStr: '10:00',
      candleIndex: 5,
      isMajorPool: false,
      isSwept: false,
    };

    // Nến quét đỉnh:
    // High = 2055.0 (quét qua 2050 sâu 5.0 điểm = 0.5 ATR -> hợp lệ [0.1 ATR - 1.5 ATR])
    // Close = 2042.0 (đóng ngược xuống dưới 2050)
    // Low = 2040.0
    // Open = 2044.0
    // Candle length = 2055 - 2040 = 15
    // Upper wick = 2055 - max(2044, 2042) = 2055 - 2044 = 11 -> wick ratio = 11/15 = 73.3% >= 40%
    const sweepCandle = createCandle(1700009000000, 2044.0, 2055.0, 2040.0, 2042.0);

    const signal = service.detectSweepOnCandle(sweepCandle, [bslPool], atr, 'SELL');

    assert.strictEqual(signal.hasSweep, true, 'Phải phát hiện BSL Sweep');
    assert.strictEqual(signal.type, 'SELL_SWEEP');
    assert.strictEqual(signal.sweepDepth, 5.0);
    assert.strictEqual(signal.sweepDepthAtrRatio, 0.5);
    assert.ok(signal.wickRatio >= 0.4, 'Tỷ lệ râu trên >= 40%');
    // Suggested SL = candle.high + 0.2 * atr = 2055 + 2 = 2057
    assert.strictEqual(signal.suggestedSL, 2057.0);
  });

  it('7. Loại bỏ các trường hợp KHÔNG hợp lệ (Negative test cases)', () => {
    const atr = 10.0;
    const sslPool = {
      id: 'SSL_1',
      type: 'SSL',
      price: 2000.0,
      time: 1700000000000,
      timeStr: '10:00',
      candleIndex: 5,
      isMajorPool: false,
      isSwept: false,
    };

    // Case 1: Chạm quá nhẹ (< 0.1 ATR = < 1.0)
    const shallowCandle = createCandle(1700009000000, 2005, 2010, 1999.5, 2008);
    const resShallow = service.detectSweepOnCandle(shallowCandle, [sslPool], atr, 'BUY');
    assert.strictEqual(resShallow.hasSweep, false, 'Không báo khi chạm quá nhẹ (< 0.1 ATR)');

    // Case 2: Đâm xả gãy cấu trúc (> 1.5 ATR = > 15.0)
    const breakoutCandle = createCandle(1700009000000, 2005, 2010, 1980.0, 2002);
    const resBreakout = service.detectSweepOnCandle(breakoutCandle, [sslPool], atr, 'BUY');
    assert.strictEqual(resBreakout.hasSweep, false, 'Không báo khi xả gãy quá sâu (> 1.5 ATR)');

    // Case 3: Nến đóng thủng ra ngoài (không rút râu đóng lại vào trong)
    const closeBelowCandle = createCandle(1700009000000, 2005, 2010, 1995.0, 1998.0);
    const resCloseBelow = service.detectSweepOnCandle(closeBelowCandle, [sslPool], atr, 'BUY');
    assert.strictEqual(resCloseBelow.hasSweep, false, 'Không báo khi nến đóng dưới mức đáy cũ (phá vỡ thực sự)');

    // Case 4: Râu nến ngắn (< 40%)
    // Length = 2010 - 1995 = 15. Lower wick = min(2000, 2004) - 1995 = 5 -> wick ratio = 5/15 = 33.3% < 40%
    const shortWickCandle = createCandle(1700009000000, 2000.0, 2010.0, 1995.0, 2004.0);
    const resShortWick = service.detectSweepOnCandle(shortWickCandle, [sslPool], atr, 'BUY');
    assert.strictEqual(resShortWick.hasSweep, false, 'Không báo khi râu nến < 40%');

    // Case 5: Pool đã bị đánh dấu isSwept từ trước
    const alreadySweptPool = { ...sslPool, isSwept: true, sweptAt: 1700005000000 };
    const validCandle = createCandle(1700009000000, 2005.0, 2010.0, 1996.0, 2008.0);
    const resAlreadySwept = service.detectSweepOnCandle(validCandle, [alreadySweptPool], atr, 'BUY');
    assert.strictEqual(resAlreadySwept.hasSweep, false, 'Không báo khi pool đã bị swept từ trước');
  });

  it('8. checkRecentSweep kiểm tra cả nến hiện tại hoặc nến áp chót', () => {
    const baseTime = 1700000000000;
    const m15Candles = [];

    // Tạo nến M15 có đáy Pivot Low tại 2000 (index 5)
    for (let i = 0; i < 5; i++) m15Candles.push(createCandle(baseTime + i * 900000, 2020, 2030, 2010, 2015));
    m15Candles.push(createCandle(baseTime + 5 * 900000, 2010, 2015, 2000, 2005)); // Pivot low = 2000
    for (let i = 6; i <= 15; i++) m15Candles.push(createCandle(baseTime + i * 900000, 2015, 2025, 2008, 2020));

    // Nến M5 áp chót (index -2) thực hiện quét đáy
    const prevM5Candle = createCandle(baseTime + 20 * 900000, 2005, 2015, 1995, 2008);
    // Nến M5 hiện tại (index -1) dao động bình thường
    const currentM5Candle = createCandle(baseTime + 21 * 900000, 2008, 2018, 2006, 2012);

    const sweepResult = service.checkRecentSweep([prevM5Candle, currentM5Candle], m15Candles, 'BUY', 10.0);
    assert.strictEqual(sweepResult.hasSweep, true, 'Phải phát hiện cú quét từ nến áp chót');
    assert.strictEqual(sweepResult.type, 'BUY_SWEEP');
  });
});
