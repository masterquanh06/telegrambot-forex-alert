const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SubscriberCacheService,
  isTierEnabledForSubscriber,
  defaultSubscriber,
} = require('../dist/common/subscriber-cache.service');
const { SuperTierService } = require('../dist/common/super-tier.service');

test('Granular Tier Settings & Subscriber Filtering (Tier 0, 1, 2, 3, SSS)', async (t) => {
  await t.test('1. isTierEnabledForSubscriber: tắt riêng từng Tier không ảnh hưởng các Tier còn lại', () => {
    const sub = defaultSubscriber('u1');
    assert.equal(isTierEnabledForSubscriber(sub, '0'), true);
    assert.equal(isTierEnabledForSubscriber(sub, '1'), true);
    assert.equal(isTierEnabledForSubscriber(sub, '2'), true);
    assert.equal(isTierEnabledForSubscriber(sub, '3'), true);
    assert.equal(isTierEnabledForSubscriber(sub, 'SSS'), true);

    // Tắt riêng Tier 1 -> Tier 0, 2, 3, SSS vẫn bật
    const offTier1 = { ...sub, tier1AlertEnabled: false };
    assert.equal(isTierEnabledForSubscriber(offTier1, '0'), true);
    assert.equal(isTierEnabledForSubscriber(offTier1, '1'), false);
    assert.equal(isTierEnabledForSubscriber(offTier1, '2'), true);
    assert.equal(isTierEnabledForSubscriber(offTier1, '3'), true);
    assert.equal(isTierEnabledForSubscriber(offTier1, 'SSS'), true);

    // Tắt riêng Tier 3 -> Tier SSS vẫn bật độc lập
    const offTier3Only = { ...sub, tier3AlertEnabled: false, tier2AlertEnabled: false, tierSssAlertEnabled: true };
    assert.equal(isTierEnabledForSubscriber(offTier3Only, '3'), false);
    assert.equal(isTierEnabledForSubscriber(offTier3Only, 'SSS'), true);

    // Tắt riêng Tier SSS -> Tier 3 vẫn bật độc lập
    const offSssOnly = { ...sub, tier3AlertEnabled: true, tierSssAlertEnabled: false };
    assert.equal(isTierEnabledForSubscriber(offSssOnly, '3'), true);
    assert.equal(isTierEnabledForSubscriber(offSssOnly, 'SSS'), false);

    // Tương thích ngược: record/mock cũ chỉ có tier2AlertEnabled=false (không có tier3AlertEnabled/tierSssAlertEnabled)
    const legacyOff = { chatId: 'legacy', tier2AlertEnabled: false };
    assert.equal(isTierEnabledForSubscriber(legacyOff, '3'), false);
    assert.equal(isTierEnabledForSubscriber(legacyOff, 'SSS'), false);
  });

  await t.test('2. SubscriberCacheService: patch(), toggleTier(), applyTierPreset() đồng bộ RAM ngay & lưu DB', async () => {
    const upsertCalls = [];
    const mockPrisma = {
      executeWithRetry: async (fn) => fn(),
      telegramUser: {
        findMany: async () => [
          {
            chatId: 'u_main',
            bbAtrAlertEnabled: true,
            bbTier0AlertEnabled: true,
            tier1AlertEnabled: true,
            tier2SignalEnabled: true,
            tier3AlertEnabled: true,
            tierSssAlertEnabled: true,
            bbAtrBias: 'BOTH',
            nweAlertEnabled: true,
            nweTimeframes: ['M5', 'M15', 'H1', 'H4'],
            smcAlertEnabled: true,
            smcTimeframes: ['M5', 'M15', 'H1', 'H4'],
            tier2AlertEnabled: true,
          },
        ],
        upsert: async (args) => {
          upsertCalls.push(args);
          return args;
        },
      },
    };

    const cache = new SubscriberCacheService(mockPrisma);
    await cache.refresh();
    assert.equal(cache.isReady(), true);

    // Toggle Tier 1 -> tắt ngay trong RAM
    const resT1 = await cache.toggleTier('u_main', '1');
    assert.equal(resT1.enabled, false);
    assert.equal(cache.get('u_main').tier1AlertEnabled, false);
    assert.equal(cache.get('u_main').tier2SignalEnabled, true);
    assert.equal(upsertCalls[upsertCalls.length - 1].update.tier1AlertEnabled, false);

    // Toggle Tier SSS -> tắt độc lập, Tier 3 vẫn bật
    const resSss = await cache.toggleTier('u_main', 'SSS');
    assert.equal(resSss.enabled, false);
    assert.equal(cache.get('u_main').tierSssAlertEnabled, false);
    assert.equal(cache.get('u_main').tier3AlertEnabled, true);

    // Preset VIP_ONLY -> tắt 0, 1, 2; bật 3 & SSS
    const vipSettings = await cache.applyTierPreset('u_main', 'VIP_ONLY');
    assert.deepEqual(vipSettings, {
      tier0: false,
      tier1: false,
      tier2: false,
      tier3: true,
      tierSss: true,
    });

    // Preset ALL -> bật lại tất cả
    const allSettings = await cache.applyTierPreset('u_main', 'ALL');
    assert.deepEqual(allSettings, {
      tier0: true,
      tier1: true,
      tier2: true,
      tier3: true,
      tierSss: true,
    });
  });

  await t.test('3. SuperTierService: lọc đúng cờ Tier SSS độc lập với Tier 3 từ SubscriberCache', async () => {
    const sentTo = [];
    const mockPrisma = {
      executeWithRetry: async (fn) => fn(),
      telegramUser: {
        findMany: async () => [
          {
            chatId: 'u_sss_on_t3_off',
            tier3AlertEnabled: false,
            tier2AlertEnabled: false,
            tierSssAlertEnabled: true,
          },
          {
            chatId: 'u_sss_off_t3_on',
            tier3AlertEnabled: true,
            tier2AlertEnabled: true,
            tierSssAlertEnabled: false,
          },
        ],
      },
    };
    const cache = new SubscriberCacheService(mockPrisma);
    await cache.refresh();

    const mockTelegram = {
      sendMessage: async (chatId) => {
        sentTo.push(chatId);
        return true;
      },
    };

    const sssSvc = new SuperTierService(mockPrisma, mockTelegram, undefined, cache);
    const now = Date.now();
    await sssSvc.reportTier3Event({
      source: 'BB_ATR',
      direction: 'SELL',
      triggeredAtMs: now,
      candleTimeMs: now - 60_000,
      currentPrice: 3620,
      slPrice: 3630,
      tp1Price: 3600,
      summary: 'BB Tier 3',
    });
    await sssSvc.reportTier3Event({
      source: 'SMC_NWE',
      direction: 'SELL',
      triggeredAtMs: now + 1000,
      candleTimeMs: now - 60_000,
      currentPrice: 3619,
      slPrice: 3635,
      tp1Price: 3580,
      tp2Price: 3580,
      summary: 'SMC Tier 3',
    });

    assert.ok(sentTo.includes('u_sss_on_t3_off'), 'User bật Tier SSS (dù tắt Tier 3) phải nhận Tier SSS');
    assert.ok(!sentTo.includes('u_sss_off_t3_on'), 'User tắt Tier SSS (dù bật Tier 3) không được nhận Tier SSS');
  });
});
