import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.connectWithRetry();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Thử kết nối lại Database nếu bị ngắt kết nối (Re-connect handler)
   */
  async connectWithRetry(retries = 3, delayMs = 2000) {
    for (let i = 0; i < retries; i++) {
      try {
        await this.$connect();
        return;
      } catch (error) {
        this.logger.warn(`Thử kết nối lại PostgreSQL (NeonDB) thất bại (Lần ${i + 1}/${retries}): ${error.message}`);
        if (i === retries - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Chạy hàm query với cơ chế tự động reconnect nếu kết nối NeonDB bị sập tạm thời
   */
  async executeWithRetry<T>(queryFn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await queryFn();
      } catch (error: any) {
        const isPoolOrClosedError =
          error?.message?.includes('Server has closed the connection') ||
          error?.message?.includes('Kind: Closed') ||
          error?.message?.includes('Timed out fetching a new connection from the connection pool') ||
          error?.code === 'P1001' ||
          error?.code === 'P1017' ||
          error?.code === 'P2024';

        if (isPoolOrClosedError && attempt < maxRetries) {
          const errMsg = error?.code || error?.message?.slice(0, 70);
          this.logger.warn(`[Prisma] Kết nối Database nghẽn pool/gián đoạn (${errMsg}). Đang tự động thử lại (Lần ${attempt}/${maxRetries})...`);
          await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        } else {
          throw error;
        }
      }
    }
    throw new Error('Không thể thực thi câu lệnh SQL sau khi thử lại.');
  }
}
