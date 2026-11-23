const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateTierSss,
  shouldSuppressDuplicateSss,
  SSS_CONFLUENCE_WINDOW_MS,
  SSS_COOLDOWN_MS,
} = require('../dist/indicator/super-tier-classifier');
const { SuperTierService } = require('../dist/common/super-tier.service');

const BASE_MS = 1795410000000;
const MIN = 60 * 1000;

function makeBbEvent(overrides = {}) {
  return {
    source: 'BB_ATR',
    direction: 'SELL',
    triggeredAtMs: BASE_MS,
    candleTimeMs: BASE_MS - 4 * MIN,
    currentPrice: 3622.5,
    slPrice: 3632.0,
    tp1Price: 3602.4, // BB Middle (M5)
    summary: 'BB Tier 3 SELL',
    details: {
      bbUpper: 3614.0,
      bbMiddle: 3602.4,
      bbLower: 3590.8,
      upperEntry: 3623.0,
      lowerEntry: 3581.8,
      atrM5: 9.0,
      rsiValue: 73.5,
    },
    ...overrides,
  };
}

function makeSmcEvent(overrides = {}) {
  return {
    source: 'SMC_NWE',
    direction: 'SELL',
    triggeredAtMs: BASE_MS + 8 * MIN,
    candleTimeMs: BASE_MS - 6 * MIN,
    currentPrice: 3621.8,
    slPrice: 3636.4, // OB top + 0.5 ATR M15 (rộng hơn BB SL 3632.0)
    tp1Price: 3582.54, // NWE H1 Kernel
    tp2Price: 3582.54,
    summary: 'SMC Tier 3 SELL',
    details: {
      nweH1: { upperBand: 3624.7, kernel: 3582.54, lowerBand: 3539.6 },
      primaryOb: { timeframe: 'H1', bottom: 3616.3, top: 3629.6, label: 'Vùng Cung H1 (Bearish OB)' },
      matchedOrderBlocks: [
        { timeframe: 'H1', bottom: 3616.3, top: 3629.6 },
        { timeframe: 'M15', bottom: 3618.0, top: 3624.0 },
      ],
      confluenceLevel: 3624.7,
      atrM15: 13.6,
    },
    ...overrides,
  };
}

test('TIER SSS (Siêu Hợp Lưu) — evaluateTierSss, Dedup & Coordinator', async (t) => {
  await t.test('1. BB Tier 3 SELL trước, 8 phút sau SMC Tier 3 SELL -> kích hoạt TIER SSS (SELL) với SL rộng hơn + TP1 + TP2', () => {
    const bb = makeBbEvent({ triggeredAtMs: BASE_MS, slPrice: 3632.0, tp1Price: 3602.4 });
    const smc = makeSmcEvent({ triggeredAtMs: BASE_MS + 8 * MIN, slPrice: 3636.4, tp1Price: 3582.54 });

    const sss = evaluateTierSss(bb, smc, SSS_CONFLUENCE_WINDOW_MS);
    assert.ok(sss, 'Phải kích hoạt TIER SSS');
    assert.equal(sss.direction, 'SELL');
    assert.equal(sss.timeDiffMs, 8 * MIN);
    assert.equal(sss.timeDiffMinutes, 8);
    assert.equal(sss.entryPrice, 3621.8); // giá của sự kiện mới hơn (SMC)
    assert.equal(sss.safestSl, 3636.4); // max(3632.0, 3636.4)
    assert.equal(sss.tp1Price, 3602.4); // BB Middle (M5)
    assert.equal(sss.tp2Price, 3582.54); // NWE H1 Kernel
  });

  await t.test('2. SMC Tier 3 BUY trước, 5 phút sau BB Tier 3 BUY (đảo thứ tự) -> kích hoạt TIER SSS (BUY) với SL thấp/an toàn hơn', () => {
    const smcBuy = makeSmcEvent({
      direction: 'BUY',
      triggeredAtMs: BASE_MS,
      currentPrice: 3541.2,
      slPrice: 3528.5,
      tp1Price: 3582.54,
      tp2Price: 3582.54,
    });
    const bbBuy = makeBbEvent({
      direction: 'BUY',
      triggeredAtMs: BASE_MS + 5 * MIN,
      currentPrice: 3542.6,
      slPrice: 3531.0,
      tp1Price: 3558.2,
    });

    const sss = evaluateTierSss(bbBuy, smcBuy, SSS_CONFLUENCE_WINDOW_MS);
    assert.ok(sss, 'Phải kích hoạt TIER SSS BUY khi SMC xảy ra trước BB');
    assert.equal(sss.direction, 'BUY');
    assert.equal(sss.timeDiffMs, 5 * MIN);
    assert.equal(sss.entryPrice, 3542.6); // giá của sự kiện mới hơn (BB)
    assert.equal(sss.safestSl, 3528.5); // min(3531.0, 3528.5)
    assert.equal(sss.tp1Price, 3558.2); // BB Middle (M5)
    assert.equal(sss.tp2Price, 3582.54); // NWE H1 Kernel
  });

  await t.test('3. Cùng chiều nhưng lệch nhau 25 phút (> 20 phút) -> trả về null', () => {
    const bb = makeBbEvent({ triggeredAtMs: BASE_MS });
    const smc = makeSmcEvent({ triggeredAtMs: BASE_MS + 25 * MIN });

    const sss = evaluateTierSss(bb, smc, SSS_CONFLUENCE_WINDOW_MS);
    assert.equal(sss, null);
  });

  await t.test('4. Trong vòng 5 phút nhưng ngược chiều (BB SELL vs SMC BUY) -> trả về null', () => {
    const bb = makeBbEvent({ direction: 'SELL', triggeredAtMs: BASE_MS });
    const smc = makeSmcEvent({ direction: 'BUY', triggeredAtMs: BASE_MS + 5 * MIN });

    const sss = evaluateTierSss(bb, smc, SSS_CONFLUENCE_WINDOW_MS);
    assert.equal(sss, null);
  });

  await t.test('5. Chống bắn trùng theo sssKey và cooldown 15 phút cùng chiều (vẫn cho phép nếu đảo chiều)', () => {
    const bb = makeBbEvent({ triggeredAtMs: BASE_MS, candleTimeMs: BASE_MS - 4 * MIN });
    const smc = makeSmcEvent({ triggeredAtMs: BASE_MS + 5 * MIN, candleTimeMs: BASE_MS - 6 * MIN });
    const sss1 = evaluateTierSss(bb, smc);

    const stateAfterFirst = {
      lastSssKey: sss1.sssKey,
      lastSssDirection: sss1.direction,
      lastSssAlertTime: BASE_MS + 5 * MIN,
    };

    // 5A: Trùng đúng cặp (bbCandleTimeMs, smcCandleTimeMs) kể cả sau 30 phút -> BỊ CHẶN
    assert.equal(
      shouldSuppressDuplicateSss(sss1, stateAfterFirst, BASE_MS + 35 * MIN, SSS_COOLDOWN_MS),
      true,
    );

    // 5B: Cặp nến mới nhưng vẫn cùng chiều SELL và mới qua 10 phút (< 15 phút cooldown) -> BỊ CHẶN
    const sssNewPairSell = evaluateTierSss(
      makeBbEvent({ triggeredAtMs: BASE_MS + 15 * MIN, candleTimeMs: BASE_MS + 10 * MIN }),
      makeSmcEvent({ triggeredAtMs: BASE_MS + 15 * MIN, candleTimeMs: BASE_MS + 9 * MIN }),
    );
    assert.equal(
      shouldSuppressDuplicateSss(sssNewPairSell, stateAfterFirst, BASE_MS + 15 * MIN, SSS_COOLDOWN_MS),
      true,
    );

    // 5C: Cùng chiều SELL, cặp nến mới, đã qua 16 phút (>= 15 phút cooldown) -> ĐƯỢC PHÉP BẮN
    assert.equal(
      shouldSuppressDuplicateSss(sssNewPairSell, stateAfterFirst, BASE_MS + 21 * MIN, SSS_COOLDOWN_MS),
      false,
    );

    // 5D: Đảo chiều sang BUY trong vòng 10 phút (< 15 phút cooldown) -> KHÔNG BỊ CHẶN vì khác chiều
    const sssOppositeBuy = evaluateTierSss(
      makeBbEvent({ direction: 'BUY', triggeredAtMs: BASE_MS + 12 * MIN, candleTimeMs: BASE_MS + 10 * MIN }),
      makeSmcEvent({ direction: 'BUY', triggeredAtMs: BASE_MS + 13 * MIN, candleTimeMs: BASE_MS + 9 * MIN }),
    );
    assert.equal(
      shouldSuppressDuplicateSss(sssOppositeBuy, stateAfterFirst, BASE_MS + 13 * MIN, SSS_COOLDOWN_MS),
      false,
    );
  });

  await t.test('6. SuperTierService: không rơi event khi BB & SMC báo cáo đồng thời và HTML parse_mode an toàn 100%', async () => {
    const sentMessages = [];
    const mockPrisma = {
      executeWithRetry: async (fn) => fn(),
      telegramUser: {
        findMany: async () => [
          { chatId: 'u_vip', tier2AlertEnabled: true },
          { chatId: 'u_off', tier2AlertEnabled: false },
        ],
      },
    };
    const mockTelegram = {
      sendMessage: async (chatId, msg) => {
        sentMessages.push({ chatId, msg });
      },
    };

    const svc = new SuperTierService(mockPrisma, mockTelegram);
    const bb = makeBbEvent({ triggeredAtMs: Date.now() });
    const smc = makeSmcEvent({ triggeredAtMs: Date.now() + 2000 });

    // Gọi song song gần như đồng thời
    await Promise.all([svc.reportTier3Event(bb), svc.reportTier3Event(smc)]);

    // Chỉ gửi tới u_vip (và không gửi cho u_off đã tắt VIP), đúng 1 lần duy nhất
    const vipMsgs = sentMessages.filter((m) => m.chatId === 'u_vip');
    const offMsgs = sentMessages.filter((m) => m.chatId === 'u_off');
    assert.equal(vipMsgs.length, 1);
    assert.equal(offMsgs.length, 0);

    // Kiểm tra HTML an toàn (không có thẻ lạ hoặc < > & trần)
    const html = vipMsgs[0].msg;
    assert.equal(/<(?!\/?(b|i|code|u|s|pre|a)\b)/.test(html), false, 'Không được chứa ký tự < chưa escape');
    assert.equal(/&(?!amp;|lt;|gt;|quot;)/.test(html), false, 'Không được chứa ký tự & chưa escape');
  });

  await t.test('7. CallMeBotService: buildSpokenMessage chuẩn <= 250 ký tự và SuperTierService kích hoạt gọi TIER_SSS', async () => {
    const { CallMeBotService } = require('../dist/common/callmebot.service');
    const callSvc = new CallMeBotService({
      get: (k) => ({ CALLMEBOT_ENABLED: 'true', CALLMEBOT_USERS: '@trader_a, @trader_b' })[k],
    });

    assert.deepEqual(callSvc.getConfiguredUsers(), ['@trader_a', '@trader_b']);

    const msgSss = callSvc.buildSpokenMessage({
      reason: 'TIER_SSS',
      direction: 'SELL',
      price: 3623.9,
      slPrice: 3636.4,
    });
    assert.ok(msgSss.length <= 250);
    assert.ok(msgSss.includes('Tier S S S') && msgSss.includes('Bán'));

    const msgSmc = callSvc.buildSpokenMessage({
      reason: 'SMC_TIER_3',
      direction: 'BUY',
      price: 3541.5,
      slPrice: 3528.4,
      detailText: 'khung H4 M15',
    });
    assert.ok(msgSmc.length <= 250);
    assert.ok(msgSmc.includes('Tier 3') && msgSmc.includes('Mua'));

    // Kiểm tra SuperTierService tự động gọi callMeBotService khi nổ TIER SSS
    const calledReasons = [];
    const mockCallMeBot = {
      triggerVoiceCall: async (p) => {
        calledReasons.push(p);
        return 1;
      },
    };
    const mockPrisma = {
      executeWithRetry: async (fn) => fn(),
      telegramUser: { findMany: async () => [{ chatId: 'u_vip', tier2AlertEnabled: true }] },
    };
    const mockTelegram = { sendMessage: async () => {} };

    const supSvc = new SuperTierService(mockPrisma, mockTelegram, mockCallMeBot);
    await supSvc.reportTier3Event(makeBbEvent({ triggeredAtMs: Date.now() }));
    await supSvc.reportTier3Event(makeSmcEvent({ triggeredAtMs: Date.now() + 1000 }));

    assert.equal(calledReasons.length, 1);
    assert.equal(calledReasons[0].reason, 'TIER_SSS');
    assert.equal(calledReasons[0].direction, 'SELL');
  });
});
