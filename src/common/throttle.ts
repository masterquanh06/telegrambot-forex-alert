/**
 * Throttle kiểu leading + 1 trailing:
 * - Gọi ngay nếu đã qua `intervalMs` kể từ lần chạy trước (leading)
 * - Các lệnh gọi trong cửa sổ được gom thành 1 lần chạy duy nhất ở cuối cửa sổ (trailing)
 */
export function createLeadingTrailingThrottle(fn: () => void, intervalMs: number) {
  let lastRunAt = 0;
  let timer: NodeJS.Timeout | null = null;

  const trigger = () => {
    const now = Date.now();
    const wait = lastRunAt + intervalMs - now;
    if (wait > 0) {
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          trigger();
        }, wait);
        timer.unref?.();
      }
      return;
    }
    lastRunAt = now;
    fn();
  };

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { trigger, cancel };
}
