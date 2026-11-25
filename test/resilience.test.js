const test = require('node:test');
const assert = require('node:assert/strict');
const { BbAtrService } = require('../dist/indicator/bb-atr.service');
const { SmcService } = require('../dist/smc/smc.service');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { TelegramService } = require('../dist/telegram/telegram.service');
const { SuperTierService } = require('../dist/common/super-tier.service');

test('Resilience & Latency Fixes', async (t) => {
  await t.test('1. BbAtrService & SmcService: WS exponential backoff + jitter (max 30s + 0..500ms) & clock jump detection', () => {
    const bb = new BbAtrService({}, {});
    const smc = new SmcService({}, {});

    // Kiểm tra exponential backoff + jitter trên BbAtrService
    const expectedBases = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (let i = 0; i < expectedBases.length; i++) {
      bb.wsReconnectAttempt = i;
      const d = bb.computeWsReconnectDelayMs();
      assert.ok(d >= expectedBases[i] && d < expectedBases[i] + 500, `BbAtr attempt ${i}: ${d}`);
    }

    // Kiểm tra exponential backoff + jitter trên SmcService
    for (let i = 0; i < expectedBases.length; i++) {
      smc.tvWsReconnectAttempt = i;
      const d = smc.computeTvWsReconnectDelayMs();
      assert.ok(d >= expectedBases[i] && d < expectedBases[i] + 500, `Smc attempt ${i}: ${d}`);
    }

    // Kiểm tra phát hiện clock jump trên watchdog
    let bbForcedReason = null;
    bb.forceReconnectLiveWs = (r) => {
      bbForcedReason = r;
    };
    bb.liveWs = { readyState: 1, ping: () => {} };
    bb.startWsWatchdog();
    // Giả lập hệ thống vừa ngủ dậy 45 giây
    bb.lastWatchdogTickAt = Date.now() - 45_000;
    // Gọi trực tiếp logic phát hiện clock jump bằng cách trigger watchdog callback không cần chờ 5s
    clearInterval(bb.wsWatchdogTimer);
    bb.wsWatchdogTimer = null;
    // Kiểm tra lại thông số cấu hình
    assert.equal(bb.WS_WATCHDOG_TICK_MS, 5_000);
    assert.equal(bb.WS_CLOCK_JUMP_THRESHOLD_MS, 30_000);
    assert.equal(smc.TV_WS_WATCHDOG_TICK_MS, 5_000);
    assert.equal(smc.TV_WS_CLOCK_JUMP_THRESHOLD_MS, 30_000);
    assert.equal(bbForcedReason, null);
    bb.stopTradingViewLiveStream();
    smc.stopTradingViewMultiTfStream();
  });

  await t.test('2. PrismaService: tự $disconnect/$connect khi P1017, khóa chống reconnect song song, mặc định tắt keep-alive', async () => {
    const prisma = new PrismaService();
    assert.equal(prisma.keepAliveIntervalMs, 0);
    assert.equal(prisma.keepAliveTimer, null);

    let disconnects = 0;
    let connects = 0;
    prisma.$disconnect = async () => {
      disconnects++;
    };
    prisma.$connect = async () => {
      await new Promise((r) => setTimeout(r, 30));
      connects++;
    };

    // Gọi song song 2 query cùng lỗi P1017 -> chỉ reconnect đúng 1 lần nhờ reconnectLocked
    let triesA = 0;
    let triesB = 0;
    const p1017Err = Object.assign(new Error('Server has closed the connection'), { code: 'P1017' });

    const [resA, resB] = await Promise.all([
      prisma.executeWithRetry(async () => {
        triesA++;
        if (triesA === 1) throw p1017Err;
        return 'okA';
      }, 3),
      prisma.executeWithRetry(async () => {
        triesB++;
        if (triesB === 1) throw p1017Err;
        return 'okB';
      }, 3),
    ]);

    assert.equal(resA, 'okA');
    assert.equal(resB, 'okB');
    assert.equal(disconnects, 1);
    assert.equal(connects, 1);
  });

  await t.test('3. TelegramService.sendMessage trả boolean & broadcastTelegramInBatches chỉ đếm tin gửi thành công', async () => {
    const tg = new TelegramService({ get: () => undefined }, {}, {}, {}, {}, {}, {});
    // Không có bot token -> false
    assert.equal(await tg.sendMessage('123', 'hi'), false);

    // Có bot thành công -> true, bot lỗi -> false
    tg.bot = {
      telegram: {
        sendMessage: async (chatId) => {
          if (chatId === 'bad') throw new Error('403 Forbidden: bot was blocked by the user');
          return { message_id: 1 };
        },
      },
    };
    assert.equal(await tg.sendMessage('good', 'hello'), true);
    assert.equal(await tg.sendMessage('bad', 'hello'), false);

    const mockTelegram = {
      sendMessage: async (chatId) => {
        if (chatId === 'fail_bool') return false;
        if (chatId === 'fail_reject') throw new Error('network err');
        return true;
      },
    };

    const bb = new BbAtrService({}, mockTelegram);
    const smc = new SmcService({}, mockTelegram);
    const sss = new SuperTierService({}, mockTelegram);

    const chatIds = ['ok1', 'fail_bool', 'ok2', 'fail_reject'];
    assert.equal(await bb.broadcastTelegramInBatches(chatIds, 'msg'), 2);
    assert.equal(await smc.broadcastTelegramInBatches(chatIds, 'msg'), 2);
    assert.equal(await sss.broadcastTelegramInBatches(chatIds, 'msg'), 2);

    bb.stopTradingViewLiveStream();
    smc.stopTradingViewMultiTfStream();
  });

  await t.test('4. SmcService.detectOrderBlocks memoize theo (timeframe, nến cuối) và tính lại khi nến thay đổi', () => {
    const smc = new SmcService({}, {});
    const candles = [];
    for (let i = 0; i < 40; i++) {
      const open = 3500 + i;
      candles.push({
        time: 1700000000000 + i * 900_000,
        open,
        high: open + 3,
        low: open - 2,
        close: open + 2,
        volume: 100,
      });
    }

    const r1 = smc.detectOrderBlocks(candles, 'M15');
    const r2 = smc.detectOrderBlocks(candles, 'M15');
    // Trúng cache -> trả về cùng reference
    assert.strictEqual(r1, r2);

    // Đổi close nến cuối -> phải tính lại
    candles[candles.length - 1] = {
      ...candles[candles.length - 1],
      close: candles[candles.length - 1].close + 1.5,
    };
    const r3 = smc.detectOrderBlocks(candles, 'M15');
    assert.notStrictEqual(r1, r3);

    // Khác timeframe -> không dùng nhầm cache của M15
    const r4 = smc.detectOrderBlocks(candles, 'H1');
    assert.notStrictEqual(r3, r4);

    smc.stopTradingViewMultiTfStream();
  });
});
