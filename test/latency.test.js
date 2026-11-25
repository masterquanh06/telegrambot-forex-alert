const test = require('node:test');
const assert = require('node:assert/strict');
const { createLeadingTrailingThrottle } = require('../dist/common/throttle');
const { SubscriberCacheService } = require('../dist/common/subscriber-cache.service');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('throttle: 50 tick liên tiếp -> 1 leading + 1 trailing', async () => {
  let calls = 0;
  const th = createLeadingTrailingThrottle(() => calls++, 100);
  for (let i = 0; i < 50; i++) th.trigger();
  assert.equal(calls, 1);
  await sleep(160);
  assert.equal(calls, 2);
  await sleep(150);
  assert.equal(calls, 2);
  th.cancel();
});

test('throttle: cancel hủy trailing', async () => {
  let calls = 0;
  const th = createLeadingTrailingThrottle(() => calls++, 100);
  th.trigger();
  th.trigger();
  th.cancel();
  await sleep(150);
  assert.equal(calls, 1);
});

function fakePrisma(rows, failRef) {
  return {
    executeWithRetry: async (fn) => {
      if (failRef.fail) throw new Error('db down');
      return fn();
    },
    telegramUser: { findMany: async () => rows },
  };
}

test('cache: refresh nạp user, patch/ensure phản ánh ngay', async () => {
  const failRef = { fail: false };
  const c = new SubscriberCacheService(
    fakePrisma(
      [{ chatId: '1', bbAtrAlertEnabled: false, bbAtrBias: 'SELL_ONLY', nweTimeframes: ['H1'], smcTimeframes: ['M15'], tier2AlertEnabled: false }],
      failRef,
    ),
  );
  assert.equal(c.isReady(), false);
  await c.refresh();
  assert.equal(c.isReady(), true);
  const u = c.get('1');
  assert.equal(u.bbAtrAlertEnabled, false);
  assert.equal(u.bbAtrBias, 'SELL_ONLY');
  assert.equal(u.tier2AlertEnabled, false);
  assert.equal(u.bbTier0AlertEnabled, true);

  c.patch('1', { tier2AlertEnabled: true, bbAtrBias: 'BOTH' });
  assert.equal(c.get('1').tier2AlertEnabled, true);
  assert.equal(c.get('1').bbAtrBias, 'BOTH');

  c.ensure('2');
  assert.equal(c.get('2').bbAtrAlertEnabled, true);
  assert.deepEqual(c.get('2').nweTimeframes, ['M5', 'M15', 'H1', 'H4']);
  c.ensure('2');
  assert.equal(c.getAll().length, 2);
});

test('cache: DB lỗi khi refresh không làm rỗng cache (stale-while-error)', async () => {
  const failRef = { fail: false };
  const c = new SubscriberCacheService(fakePrisma([{ chatId: '9' }], failRef));
  await c.refresh();
  assert.equal(c.getAll().length, 1);
  failRef.fail = true;
  await assert.rejects(() => c.refresh());
  assert.equal(c.isReady(), true);
  assert.equal(c.getAll().length, 1);
});
