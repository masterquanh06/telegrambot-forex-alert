import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private reconnectPromise: Promise<void> | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private readonly keepAliveIntervalMs = Math.max(0, Number(process.env.DB_KEEPALIVE_INTERVAL_MS) || 0);

  async onModuleInit() {
    await this.connectWithRetry(5, 1000).catch((err) => {
      this.logger.error(`[Prisma] Khởi tạo kết nối DB thất bại sau 5 lần thử: ${err?.message}`);
    });

    // Giữ DB_KEEPALIVE_INTERVAL_MS = 0 theo mặc định để không tốn quota compute Neon Free
    if (this.keepAliveIntervalMs > 0) {
      this.keepAliveTimer = setInterval(() => {
        this.$queryRaw`SELECT 1`.catch((err) => {
          this.logger.warn(`[Prisma] Keep-alive thất bại: ${err?.message}`);
        });
      }, this.keepAliveIntervalMs);
      this.keepAliveTimer.unref?.();
    }
  }

  async onModuleDestroy() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    await this.$disconnect();
  }

  /**
   * Ngắt kết nối cũ và mở lại kết nối mới, có khóa chống reconnect song song
   */
  private async reconnectLocked(): Promise<void> {
    if (!this.reconnectPromise) {
      this.reconnectPromise = (async () => {
        await this.$disconnect().catch(() => {});
        await this.$connect();
      })().finally(() => {
        this.reconnectPromise = null;
      });
    }
    return this.reconnectPromise;
  }

  /**
   * Thử kết nối lại Database nếu bị ngắt kết nối (Re-connect handler)
   */
  async connectWithRetry(retries = 5, baseDelayMs = 1000) {
    for (let i = 0; i < retries; i++) {
      try {
        await this.$connect();
        return;
      } catch (error: any) {
        this.logger.warn(`Thử kết nối lại PostgreSQL (NeonDB) thất bại (Lần ${i + 1}/${retries}): ${error.message}`);
        if (i === retries - 1) throw error;
        const delayMs = Math.min(8_000, baseDelayMs * Math.pow(2, i));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Chạy hàm query với cơ chế tự động $disconnect/$connect khi gặp lỗi P1017/P1001/P1008/P2024
   */
  async executeWithRetry<T>(queryFn: () => Promise<T>, maxRetries = 5): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await queryFn();
      } catch (error: any) {
        const isPoolOrClosedError =
          error?.message?.includes('Server has closed the connection') ||
          error?.message?.includes('Kind: Closed') ||
          error?.message?.includes('Timed out fetching a new connection from the connection pool') ||
          error?.message?.includes('Connection reset by peer') ||
          error?.message?.includes("Can't reach database server") ||
          error?.code === 'P1001' ||
          error?.code === 'P1008' ||
          error?.code === 'P1017' ||
          error?.code === 'P2024';

        if (isPoolOrClosedError && attempt < maxRetries) {
          const errMsg = error?.code || error?.message?.slice(0, 70);
          const delayMs = Math.min(8_000, 500 * Math.pow(2, attempt - 1));
          this.logger.warn(
            `[Prisma] Kết nối Database nghẽn pool/gián đoạn (${errMsg}). Đang reset kết nối và thử lại sau ${delayMs}ms (Lần ${attempt}/${maxRetries})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          await this.reconnectLocked().catch(() => {});
        } else {
          throw error;
        }
      }
    }
    throw new Error('Không thể thực thi câu lệnh SQL sau khi thử lại.');
  }
}
