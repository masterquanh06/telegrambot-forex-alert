import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Markup } from 'telegraf';
import { WatchlistService } from '../watchlist/watchlist.service';
import { MacroService } from '../macro/macro.service';
import { GoldService } from '../gold/gold.service';
import { AlertService } from '../alert/alert.service';
import { BbAtrService } from '../indicator/bb-atr.service';
import { SmcService } from '../smc/smc.service';
import { UserXauSettings, XauTimeframe } from '../gold/gold.interface';
import { UserSmcSettings, SmcTimeframe } from '../smc/smc.interface';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf;

  constructor(
    private readonly configService: ConfigService,
    private readonly watchlistService: WatchlistService,
    private readonly macroService: MacroService,
    private readonly goldService: GoldService,
    @Inject(forwardRef(() => AlertService))
    private readonly alertService: AlertService,
    @Inject(forwardRef(() => BbAtrService))
    private readonly bbAtrService: BbAtrService,
    @Inject(forwardRef(() => SmcService))
    private readonly smcService: SmcService,
  ) {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.error('TELEGRAM_BOT_TOKEN chưa được cấu hình trong file .env');
    } else {
      this.bot = new Telegraf(token);
    }
  }

  async onModuleInit() {
    if (!this.bot) return;

    this.registerCommands();
    this.bot.launch().then(() => {
      this.logger.log('🤖 Telegram Bot đã khởi chạy thành công và đang lắng nghe câu lệnh...');
    }).catch((err) => {
      this.logger.error(`Không thể kết nối Telegram Bot: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    if (this.bot) {
      try {
        this.bot.stop('SIGTERM');
        this.logger.log('🛑 Telegram Bot đã ngắt kết nối an toàn.');
      } catch (e) {}
    }
  }

  private registerCommands() {
    // Middleware: Ghi nhận chatId của người dùng tương tác để fallback cảnh báo ngay cả khi DB nghẽn
    this.bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id?.toString();
      if (chatId) {
        this.bbAtrService.registerActiveChat(chatId);
        this.smcService.registerActiveChat(chatId);
      }
      return next();
    });

    // 1. /start hoặc /help
    this.bot.command(['start', 'help'], async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const username = ctx.from?.username || ctx.from?.first_name;
      await this.watchlistService.registerUser(chatId, username);

      const helpMessage = `
🌐 <b>CHÀO MỪNG ĐẾN VỚI BOT PHÂN TÍCH TÀI CHÍNH, VĨ MÔ & CẢNH BÁO GIÁ</b>

🎯 <b>CHIẾN LƯỢC BOLLINGER BANDS (20) + ATR (14) M5:</b>
• Dùng lệnh <code>/bbatr</code> (hoặc <code>/bb</code>) để mở bảng đo kỹ thuật, các mốc Entry & trạng thái cảnh báo M5.
• <b>Công thức Entry:</b>
  - 🔴 <b>Sell Entry (Bán):</b> <code>Bands(20) Upper + ATR(14)</code> (Overbought Exhaustion)
  - 🟢 <b>Buy Entry (Mua):</b> <code>Bands(20) Lower - ATR(14)</code> (Oversold Exhaustion)
• Cú pháp: <code>/bbatr [MÃ]</code> (VD: <code>/bbatr xau</code>, <code>/bbatr btc</code>), <code>/bbatr on</code> / <code>/bbatr off</code>.
  <i>👉 Bot tự động quét liên tục mỗi 15 giây trên khung M5 và gửi cảnh báo NGAY LẬP TỨC khi giá chạm hoặc khớp điều kiện!</i>

🌊 <b>CHIẾN LƯỢC NADARAYA-WATSON ENVELOPE (NWE + DYNAMIC S/R):</b>
• Dùng lệnh <code>/nwe</code> để mở Bảng Dashboard NWE, xem dải biên Upper/Lower & Hỗ trợ/Kháng cự động.
• Cú pháp: <code>/nwe</code> (dashboard), <code>/nwe m15</code>, <code>/nwe h1</code>, <code>/nwe on</code> / <code>/nwe off</code>.

🧱 <b>CHIẾN LƯỢC SMC ORDER BLOCKS (VÙNG CUNG / CẦU):</b>
• Dùng lệnh <code>/ob</code> (hoặc <code>/smc</code>) để mở Bảng Dashboard Order Block, theo dõi các vùng Cung (Supply) & Cầu (Demand) chưa triệt tiêu.
• Cú pháp: <code>/ob</code> (dashboard), <code>/ob m15</code>, <code>/ob h1</code>, <code>/ob on</code> / <code>/ob off</code>.

🎯 <b>CẢNH BÁO GIÁ TỨC THÌ (VÀNG, CRYPTO):</b>
• Dùng lệnh <code>/alert MÃ GIÁ</code> (VD: <code>/alert xau 4200</code>, <code>/alert btc 83000</code>, <code>/alert eth 3500</code>)
• Dùng lệnh <code>/alerts</code> để xem & quản lý danh sách cảnh báo giá đang chờ.
  <i>👉 Bot tự động quét liên tục mỗi vài giây và thông báo NGAY LẬP TỨC khi giá thị trường chạm hoặc vượt ngưỡng kỳ vọng!</i>

🟡 <b>THEO DÕI & CẢNH BÁO VÀNG (XAU/USD):</b>
• Dùng lệnh <code>/gold</code> (hoặc <code>/xau</code>) để xem bảng giá & chỉ số RSI đa khung thời gian (M1 đến D1).
• Dùng lệnh <code>/goldalert</code> để cấu hình cảnh báo khi RSI Vàng chạm vùng Quá Mua / Quá Bán.

🚨 <b>CẢNH BÁO VĨ MÔ TỨC THÌ (CPI/PPI/NFP/FED):</b>
• Dùng lệnh <code>/calendar</code> hoặc <code>/macro</code> để xem lịch sự kiện kinh tế vĩ mô hôm nay.
• Dùng lệnh <code>/settings</code> để chọn mức độ ảnh hưởng của tin tức muốn nhận cảnh báo.
  <i>👉 Bot tự động phát hiện số liệu công bố Actual + Forecast + Previous và báo NGAY LẬP TỨC qua Telegram!</i>

📋 <b>DANH SÁCH CÁC LỆNH TÍNH NĂNG:</b>
🔥 <code>/tier3</code> (hoặc <code>/tier2</code>, <code>/sweep</code>) - Bật/Tắt riêng Cảnh báo Quét Thanh Khoản VIP (High Probability)
🌊 <code>/nwe</code> (hoặc <code>/envelope</code>) - Bảng Dashboard Nadaraya-Watson Envelope (NWE + Cản động)
🧱 <code>/ob</code> (hoặc <code>/smc</code>, <code>/orderblock</code>) - Bảng Dashboard SMC Order Blocks (Vùng Cung/Cầu)
🎯 <code>/bbatr</code> (hoặc <code>/bb</code>) - Chiến lược Bollinger Bands(20) + ATR(14) khung M5
🎯 <code>/alert MÃ GIÁ</code> - Đặt cảnh báo giá Vàng, BTC, ETH... (VD: <code>/alert xau 4200</code>)
📋 <code>/alerts</code> - Quản lý danh sách cảnh báo giá đang hoạt động
🟡 <code>/gold</code> (hoặc <code>/xau</code>, <code>/vang</code>) - Bảng giá & RSI đa khung thời gian Vàng (XAU/USD)
🔔 <code>/goldalert</code> (hoặc <code>/xaualert</code>) - Cài đặt cảnh báo RSI Quá mua/Quá bán Vàng
🌍 <code>/calendar</code> (hoặc <code>/macro</code>) - Lịch sự kiện kinh tế vĩ mô hôm nay (CPI, PPI, NFP, Thất nghiệp...)
⚙️ <code>/settings</code> - Cài đặt bộ lọc mức độ cảnh báo vĩ mô tức thì (Cao/TB/Thấp)
      `.trim();
      await ctx.replyWithHTML(helpMessage);
    });

    // 2. Lệnh /calendar hoặc /macro hoặc /forex - Xem lịch kinh tế vĩ mô hôm nay
    this.bot.command(['calendar', 'macro', 'forex'], async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const username = ctx.from?.username || ctx.from?.first_name;
      await this.watchlistService.registerUser(chatId, username);

      try {
        await ctx.sendChatAction('typing');
        const userLevels = await this.watchlistService.getUserMacroAlertLevels(chatId);
        const text = await this.macroService.getTodayScheduleText(userLevels);
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ Cài đặt bộ lọc vĩ mô', 'macro_open_settings')],
        ]);
        await ctx.replyWithHTML(text, keyboard);
      } catch (error: any) {
        this.logger.error(`Lỗi lệnh /calendar: ${error.message}`);
        await ctx.replyWithHTML(`⚠️ Không thể lấy lịch kinh tế vĩ mô: ${error.message}`);
      }
    });

    // 3. Lệnh /settings hoặc /macro_settings - Cài đặt mức độ ảnh hưởng cảnh báo vĩ mô
    this.bot.command(['settings', 'macro_settings', 'macrosetting', 'setting'], async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const username = ctx.from?.username || ctx.from?.first_name;
      await this.watchlistService.registerUser(chatId, username);

      const levels = await this.watchlistService.getUserMacroAlertLevels(chatId);
      const { text, keyboard } = this.renderMacroSettingsMenu(levels);
      await ctx.replyWithHTML(text, keyboard);
    });

    // Lắng nghe mở menu cài đặt vĩ mô từ nút bấm
    this.bot.action('macro_open_settings', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      await ctx.answerCbQuery();
      const levels = await this.watchlistService.getUserMacroAlertLevels(chatId);
      const { text, keyboard } = this.renderMacroSettingsMenu(levels);
      await ctx.replyWithHTML(text, keyboard);
    });

    // Lắng nghe xem lịch hôm nay từ menu cài đặt
    this.bot.action('macro_view_today', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      await ctx.answerCbQuery('📅 Đang tải lịch sự kiện hôm nay...');
      const userLevels = await this.watchlistService.getUserMacroAlertLevels(chatId);
      const text = await this.macroService.getTodayScheduleText(userLevels);
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⚙️ Cài đặt bộ lọc vĩ mô', 'macro_open_settings')],
      ]);
      await ctx.replyWithHTML(text, keyboard);
    });

    // Lắng nghe Toggle từng mức độ ảnh hưởng (-1, 0, 1)
    this.bot.action(/^macro_toggle:(-?\d+)$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const level = parseInt(ctx.match[1], 10);
      const updated = await this.watchlistService.toggleUserMacroAlertLevel(chatId, level);
      const isEnabled = updated.includes(level);
      const label = this.macroService.getImpactLabel(level);

      await ctx.answerCbQuery(
        isEnabled ? `✅ Đã BẬT: ${label}` : `❌ Đã TẮT: ${label}`,
      );

      const { text, keyboard } = this.renderMacroSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Lắng nghe Bật tất cả các mức độ
    this.bot.action('macro_set:all', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const updated = await this.watchlistService.updateUserMacroAlertLevels(chatId, [1, 0, -1]);
      await ctx.answerCbQuery('🔔 Đã BẬT tất cả các mức độ cảnh báo!');
      const { text, keyboard } = this.renderMacroSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Lắng nghe Khôi phục về mặc định (Cao + Trung bình)
    this.bot.action('macro_set:default', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const updated = await this.watchlistService.updateUserMacroAlertLevels(chatId, [1, 0]);
      await ctx.answerCbQuery('🎯 Đã khôi phục về mặc định: Cao + Trung bình!');
      const { text, keyboard } = this.renderMacroSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // 4. Lệnh /gold hoặc /xau, /vang - Xem bảng giá & RSI đa khung thời gian Vàng XAU/USD
    this.bot.command(['gold', 'xau', 'vang', 'goldrsi', 'xaursi'], async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const username = ctx.from?.username || ctx.from?.first_name;
      await this.watchlistService.registerUser(chatId, username);

      try {
        const overview = await this.goldService.getXauOverview();
        const message = this.goldService.renderOverviewMessage(overview);
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('🔄 Cập nhật giá & RSI', 'xau_view_overview'),
            Markup.button.callback('⚙️ Cài đặt cảnh báo', 'xau_open_settings'),
          ],
        ]);
        await ctx.replyWithHTML(message, keyboard);
      } catch (e: any) {
        this.logger.error(`Lỗi lệnh /gold: ${e.message}`);
        await ctx.replyWithHTML(`⚠️ Không thể lấy dữ liệu Vàng XAU/USD: ${e.message}`);
      }
    });

    // 5. Lệnh /goldalert hoặc /xaualert - Menu cấu hình cảnh báo RSI Vàng
    this.bot.command(['goldalert', 'xaualert', 'goldsetting', 'xausetting', 'goldsettings'], async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const username = ctx.from?.username || ctx.from?.first_name;
      await this.watchlistService.registerUser(chatId, username);

      const settings = await this.goldService.getUserSettings(chatId);
      const { text, keyboard } = this.renderXauSettingsMenu(settings);
      await ctx.replyWithHTML(text, keyboard);
    });

    // Action: Xem hoặc làm mới bảng RSI Vàng
    this.bot.action('xau_view_overview', async (ctx) => {
      await ctx.answerCbQuery('🔄 Đang tải dữ liệu RSI Vàng mới nhất...');
      try {
        const overview = await this.goldService.getXauOverview(true);
        const message = this.goldService.renderOverviewMessage(overview);
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('🔄 Cập nhật giá & RSI', 'xau_view_overview'),
            Markup.button.callback('⚙️ Cài đặt cảnh báo', 'xau_open_settings'),
          ],
        ]);
        try {
          await ctx.editMessageText(message, { parse_mode: 'HTML', ...keyboard });
        } catch (e) {
          await ctx.replyWithHTML(message, keyboard);
        }
      } catch (e: any) {
        await ctx.replyWithHTML(`⚠️ Không thể tải dữ liệu Vàng: ${e.message}`);
      }
    });

    // Action: Mở menu cài đặt cảnh báo Vàng
    this.bot.action('xau_open_settings', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      await ctx.answerCbQuery();
      const settings = await this.goldService.getUserSettings(chatId);
      const { text, keyboard } = this.renderXauSettingsMenu(settings);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(text, keyboard);
      }
    });

    // Action: Bật/Tắt tổng thể nhận cảnh báo Vàng
    this.bot.action('xau_toggle_master', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const updated = await this.goldService.toggleEnabled(chatId);
      await ctx.answerCbQuery(
        updated.enabled ? '🔔 Đã BẬT nhận cảnh báo RSI Vàng!' : '🔕 Đã TẮT nhận cảnh báo RSI Vàng!',
      );
      const { text, keyboard } = this.renderXauSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Bật/Tắt một khung thời gian cụ thể (M1, M5, M15, M30, H1, H4, D1)
    this.bot.action(/^xau_toggle_tf:([A-Za-z0-9]+)$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const tf = ctx.match[1] as XauTimeframe;
      const updated = await this.goldService.toggleTimeframe(chatId, tf);
      const isEnabled = updated.timeframes.includes(tf);
      const label = this.goldService.timeframeLabels[tf] || tf;

      await ctx.answerCbQuery(isEnabled ? `✅ Đã BẬT: ${label}` : `❌ Đã TẮT: ${label}`);
      const { text, keyboard } = this.renderXauSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Chọn bộ ngưỡng RSI (70/30, 75/25, 80/20)
    this.bot.action(/^xau_set_threshold:(\d+)_(\d+)$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const ob = parseInt(ctx.match[1], 10);
      const os = parseInt(ctx.match[2], 10);
      const updated = await this.goldService.setThresholdPreset(chatId, ob, os);
      await ctx.answerCbQuery(`🎯 Đã áp dụng ngưỡng: Quá mua >= ${ob} | Quá bán <= ${os}`);
      const { text, keyboard } = this.renderXauSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Bật tất cả các khung thời gian
    this.bot.action('xau_set_all_tf', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const updated = await this.goldService.updateUserSettings(chatId, {
        timeframes: ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'],
      });
      await ctx.answerCbQuery('🔔 Đã BẬT tất cả 7 khung thời gian!');
      const { text, keyboard } = this.renderXauSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Đặt về các khung khuyên dùng (M15, M30, H1, H4, D1)
    this.bot.action('xau_set_default_tf', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const updated = await this.goldService.updateUserSettings(chatId, {
        timeframes: ['M15', 'M30', 'H1', 'H4', 'D1'],
        overboughtRsi: 70,
        oversoldRsi: 30,
      });
      await ctx.answerCbQuery('🎯 Đã khôi phục khung thời gian khuyên dùng (M15, M30, H1, H4, D1)!');
      const { text, keyboard } = this.renderXauSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // 6. Lệnh /alert <MÃ> <GIÁ_MỤC_TIÊU> hoặc /alerts hoặc /alert list / del / clear
    this.bot.command(['alert', 'alerts', 'canhbao', 'pricealert', 'alertlist', 'dsalert'], async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const username = ctx.from?.username || ctx.from?.first_name;
      await this.watchlistService.registerUser(chatId, username);

      const text = ctx.message.text.trim();
      const argsStr = text.replace(/^\/(alert|alerts|canhbao|pricealert|alertlist|dsalert)(@\w+)?\s*/i, '').trim();
      const parts = argsStr.split(/\s+/).filter(Boolean);

      // Trường hợp 1: Không có tham số hoặc gõ /alerts hoặc /alert list
      if (parts.length === 0 || parts[0].toLowerCase() === 'list' || parts[0].toLowerCase() === 'ds') {
        const { text: msgText, keyboard } = await this.renderPriceAlertsView(chatId);
        return ctx.replyWithHTML(msgText, keyboard);
      }

      // Trường hợp 2: /alert help hoặc /alert ?
      if (parts[0].toLowerCase() === 'help' || parts[0] === '?') {
        const helpText = `
🎯 <b>HƯỚNG DẪN ĐẶT CẢNH BÁO GIÁ TỨC THÌ</b> 🔔

Bot sẽ theo dõi liên tục giá thị trường và gửi thông báo NGAY LẬP TỨC khi giá chạm hoặc vượt ngưỡng kỳ vọng của bạn!

📌 <b>CÚ PHÁP ĐẶT CẢNH BÁO:</b>
<code>/alert MÃ GIÁ_MỤC_TIÊU</code>

💡 <b>VÍ DỤ CỤ THỂ:</b>
🟡 <b>Vàng (XAU/USD):</b>
• <code>/alert xau 4200</code> <i>(Cảnh báo khi Vàng chạm $4,200)</i>
• <code>/alert gold 2650.5</code>

💎 <b>Tiền điện tử (Crypto):</b>
• <code>/alert btc 83000</code> <i>(Cảnh báo khi Bitcoin đạt $83,000)</i>
• <code>/alert btc 83k</code>
• <code>/alert eth 3500</code>
• <code>/alert sol 220</code>
• <code>/alert pepe 0.000015</code>

📋 <b>CÁC LỆNH QUẢN LÝ:</b>
• <code>/alerts</code> hoặc <code>/alert list</code> - Xem danh sách cảnh báo đang chờ
• <code>/alert del [MÃ_ID]</code> - Hủy một cảnh báo (VD: <code>/alert del 5</code>)
• <code>/alert clear</code> - Hủy toàn bộ cảnh báo của bạn
        `.trim();
        return ctx.replyWithHTML(helpText);
      }

      // Trường hợp 3: /alert del <id> hoặc /alert remove <id> hoặc /alert xoa <id>
      if (['del', 'remove', 'xoa', 'cancel', 'huy'].includes(parts[0].toLowerCase())) {
        if (parts.length < 2) {
          return ctx.replyWithHTML('⚠️ Vui lòng nhập mã ID cảnh báo cần hủy. Ví dụ: <code>/alert del 12</code>');
        }
        if (parts[1].toLowerCase() === 'all' || parts[1].toLowerCase() === 'tatca') {
          const res = await this.alertService.clearUserAlerts(chatId);
          return ctx.replyWithHTML(res.message);
        }
        const alertId = parseInt(parts[1], 10);
        if (isNaN(alertId) || alertId <= 0) {
          return ctx.replyWithHTML('⚠️ Mã ID không hợp lệ. Vui lòng nhập số nguyên dương. Ví dụ: <code>/alert del 12</code>');
        }
        const res = await this.alertService.deleteAlert(chatId, alertId);
        return ctx.replyWithHTML(res.message);
      }

      // Trường hợp 4: /alert clear hoặc /alert del all
      if (parts[0].toLowerCase() === 'clear') {
        const res = await this.alertService.clearUserAlerts(chatId);
        return ctx.replyWithHTML(res.message);
      }

      // Trường hợp 5: /alert <symbol> <targetPrice> (VD: /alert xau 4200 hoặc /alert btc 83000)
      if (parts.length >= 2) {
        const rawSymbol = parts[0];
        const rawTarget = parts[1];

        const waitMsg = await ctx.replyWithHTML(`⏳ Đang kiểm tra giá thị trường cho <b>${rawSymbol.toUpperCase()}</b>...`);

        const result = await this.alertService.createPriceAlert(chatId, username, rawSymbol, rawTarget);

        const keyboard = result.success
          ? Markup.inlineKeyboard([
              [
                Markup.button.callback('📋 Danh sách cảnh báo', 'alert_refresh'),
                Markup.button.callback('➕ Thêm cảnh báo mới', 'alert_new'),
              ],
            ])
          : undefined;

        try {
          if (keyboard) {
            await ctx.telegram.editMessageText(chatId, waitMsg.message_id, undefined, result.message, {
              parse_mode: 'HTML',
              ...keyboard,
            });
          } else {
            await ctx.telegram.editMessageText(chatId, waitMsg.message_id, undefined, result.message, {
              parse_mode: 'HTML',
            });
          }
        } catch (e) {
          await ctx.replyWithHTML(result.message, keyboard);
        }
        return;
      }

      // Trường hợp chỉ nhập 1 tham số mà không phải các từ khóa trên
      return ctx.replyWithHTML(
        `⚠️ Cú pháp chưa đầy đủ. Vui lòng nhập cả mã tài sản và mức giá mục tiêu.\n\n` +
        `Ví dụ:\n` +
        `• <code>/alert xau 4200</code>\n` +
        `• <code>/alert btc 83000</code>\n` +
        `• <code>/alert eth 3500</code>\n\n` +
        `👉 Gõ <code>/alert help</code> để xem hướng dẫn chi tiết.`
      );
    });

    // Action: Làm mới danh sách cảnh báo giá
    this.bot.action('alert_refresh', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      await ctx.answerCbQuery('🔄 Đang cập nhật giá mới nhất...');
      const { text, keyboard } = await this.renderPriceAlertsView(chatId);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(text, keyboard);
      }
    });

    // Action: Hướng dẫn đặt cảnh báo mới
    this.bot.action('alert_new', async (ctx) => {
      await ctx.answerCbQuery();
      const helpText = `
🎯 <b>ĐẶT CẢNH BÁO GIÁ MỚI:</b>

Gõ lệnh theo cú pháp:
<code>/alert MÃ GIÁ_MỤC_TIÊU</code>

💡 <b>Ví dụ mẫu:</b>
• <code>/alert xau 4200</code> <i>(Vàng $4,200)</i>
• <code>/alert btc 83000</code> <i>(Bitcoin $83,000)</i>
• <code>/alert eth 3500</code> <i>(Ethereum $3,500)</i>
• <code>/alert sol 220</code> <i>(Solana $220)</i>
      `.trim();
      await ctx.replyWithHTML(helpText);
    });

    // Action: Xóa một alert cụ thể qua inline button
    this.bot.action(/^alert_del:(\d+)$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const alertId = parseInt(ctx.match[1], 10);
      const res = await this.alertService.deleteAlert(chatId, alertId);
      await ctx.answerCbQuery(res.success ? `🗑 Đã xóa #${alertId}` : '⚠️ Không thể xóa');

      const { text, keyboard } = await this.renderPriceAlertsView(chatId);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(text, keyboard);
      }
    });

    // Action: Xóa tất cả cảnh báo của user
    this.bot.action('alert_clear', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const res = await this.alertService.clearUserAlerts(chatId);
      await ctx.answerCbQuery(`🗑 Đã xóa ${res.count} cảnh báo!`);
      const { text, keyboard } = await this.renderPriceAlertsView(chatId);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(text, keyboard);
      }
    });

    // 7. Lệnh /bbatr    // 7. Lệnh /bbatr hoặc /bb - Chiến lược Bollinger Bands (20) + ATR (14) khung M5
    this.bot.command(['bbatr', 'bb', 'bb_atr', 'bba', 'bollinger', 'strat'], async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const username = ctx.from?.username || ctx.from?.first_name;
      await this.watchlistService.registerUser(chatId, username);

      const text = ctx.message.text.trim();
      const argsStr = text.replace(/^\/(bbatr|bb|bb_atr|bba|bollinger|strat)(@\w+)?\s*/i, '').trim();
      const parts = argsStr.split(/\s+/).filter(Boolean);

      // Trường hợp 1: Không có tham số -> Mở Dashboard XAU/USD M5
      if (parts.length === 0) {
        try {
          await ctx.sendChatAction('typing');
          const { text: msgText, keyboard } = await this.renderBbAtrDashboardView(chatId, 'XAU', 'M5');
          return ctx.replyWithHTML(msgText, keyboard);
        } catch (err: any) {
          return ctx.replyWithHTML(`⚠️ Lỗi lấy dữ liệu BB+ATR: ${err.message}`);
        }
      }

      const firstArg = parts[0].toLowerCase();

      // Trường hợp 2: Lọc xu hướng trong ngày: /bbatr bias <buy|sell|both> hoặc /bbatr <buy|sell|both>
      if (firstArg === 'bias') {
        const biasArg = (parts[1] || '').toLowerCase();
        let targetBias: 'BOTH' | 'BUY_ONLY' | 'SELL_ONLY' = 'BOTH';
        let desc = '⚖️ CẢ 2 CHIỀU (Buy & Sell)';
        if (['buy', 'long', 'mua', 'buy_only'].includes(biasArg)) {
          targetBias = 'BUY_ONLY';
          desc = '🟢 CHỈ BUY (Bỏ qua Sell)';
        } else if (['sell', 'short', 'ban', 'sell_only'].includes(biasArg)) {
          targetBias = 'SELL_ONLY';
          desc = '🔴 CHỈ SELL (Bỏ qua Buy)';
        }

        await this.bbAtrService.setUserBias(chatId, targetBias);
        const { text: msgText, keyboard } = await this.renderBbAtrDashboardView(chatId, 'XAU', 'M5');
        return ctx.replyWithHTML(
          `✅ <b>ĐÃ CẬP NHẬT BỘ LỌC XU HƯỚNG TRONG NGÀY (BIAS):</b> <b>${desc}</b>\n\n${msgText}`,
          keyboard,
        );
      }

      if (['buy', 'long', 'mua'].includes(firstArg) && parts.length === 1) {
        await this.bbAtrService.setUserBias(chatId, 'BUY_ONLY');
        const { text: msgText, keyboard } = await this.renderBbAtrDashboardView(chatId, 'XAU', 'M5');
        return ctx.replyWithHTML(
          `✅ <b>ĐÃ CẬP NHẬT BỘ LỌC XU HƯỚNG:</b> 🟢 <b>CHỈ BUY</b> (Bỏ qua Sell)\n\n${msgText}`,
          keyboard,
        );
      }

      if (['sell', 'short', 'ban'].includes(firstArg) && parts.length === 1) {
        await this.bbAtrService.setUserBias(chatId, 'SELL_ONLY');
        const { text: msgText, keyboard } = await this.renderBbAtrDashboardView(chatId, 'XAU', 'M5');
        return ctx.replyWithHTML(
          `✅ <b>ĐÃ CẬP NHẬT BỘ LỌC XU HƯỚNG:</b> 🔴 <b>CHỈ SELL</b> (Bỏ qua Buy)\n\n${msgText}`,
          keyboard,
        );
      }

      if (['both', 'ca2', 'all'].includes(firstArg) && parts.length === 1) {
        await this.bbAtrService.setUserBias(chatId, 'BOTH');
        const { text: msgText, keyboard } = await this.renderBbAtrDashboardView(chatId, 'XAU', 'M5');
        return ctx.replyWithHTML(
          `✅ <b>ĐÃ CẬP NHẬT BỘ LỌC XU HƯỚNG:</b> ⚖️ <b>CẢ 2 CHIỀU</b> (Buy & Sell)\n\n${msgText}`,
          keyboard,
        );
      }

      // Trường hợp 3: Bật / Tắt cảnh báo tự động XAU M5
      if (['on', 'bat', 'enable'].includes(firstArg)) {
        await this.bbAtrService.setUserBbAtrEnabled(chatId, true);
        const { text: msgText, keyboard } = await this.renderBbAtrDashboardView(chatId, 'XAU', 'M5');
        return ctx.replyWithHTML(`🔔 <b>ĐÃ BẬT</b> nhận cảnh báo tự động Chiến lược BB+ATR XAU/USD M5!\n\n${msgText}`, keyboard);
      }
      if (['off', 'tat', 'disable'].includes(firstArg)) {
        await this.bbAtrService.setUserBbAtrEnabled(chatId, false);
        const { text: msgText, keyboard } = await this.renderBbAtrDashboardView(chatId, 'XAU', 'M5');
        return ctx.replyWithHTML(`🔕 <b>ĐÃ TẮT</b> nhận cảnh báo tự động Chiến lược BB+ATR XAU/USD M5.\n\n${msgText}`, keyboard);
      }

      // Trường hợp 3: Danh sách cảnh báo cá nhân
      if (['list', 'ds', 'danhsach'].includes(firstArg)) {
        const { text: msgText, keyboard } = await this.renderBbAtrAlertsView(chatId);
        return ctx.replyWithHTML(msgText, keyboard);
      }

      // Trường hợp 4: Hướng dẫn
      if (['help', '?', 'huongdan'].includes(firstArg)) {
        const helpText = this.renderBbAtrHelpText();
        return ctx.replyWithHTML(
          helpText,
          Markup.inlineKeyboard([[Markup.button.callback('📊 Xem Bảng BB+ATR M5', 'bbatr_view:XAU:M5')]]),
        );
      }

      // Trường hợp 5: Xóa cảnh báo cá nhân (/bbatr del <id>)
      if (['del', 'remove', 'xoa', 'cancel', 'huy'].includes(firstArg)) {
        if (parts.length < 2) {
          return ctx.replyWithHTML('⚠️ Vui lòng nhập mã ID cảnh báo BB+ATR cần hủy. Ví dụ: <code>/bbatr del 2</code>');
        }
        if (['all', 'tatca'].includes(parts[1].toLowerCase())) {
          const res = await this.bbAtrService.clearUserAlerts(chatId);
          return ctx.replyWithHTML(res.message);
        }
        const alertId = parseInt(parts[1], 10);
        if (isNaN(alertId) || alertId <= 0) {
          return ctx.replyWithHTML('⚠️ Mã ID không hợp lệ. Ví dụ: <code>/bbatr del 1</code>');
        }
        const res = await this.bbAtrService.deleteAlert(chatId, alertId);
        return ctx.replyWithHTML(res.message);
      }

      // Trường hợp 6: Đặt alert riêng: /bbatr alert <symbol> [timeframe]
      if (['alert', 'dat', 'set'].includes(firstArg)) {
        const rawSym = parts[1] || 'XAU';
        const rawTf = parts[2] || 'M5';
        const tf = this.bbAtrService.normalizeTimeframe(rawTf);
        const res = await this.bbAtrService.createBbAtrAlert({
          chatId,
          username,
          symbol: rawSym,
          timeframe: tf,
        });
        return ctx.replyWithHTML(
          res.message,
          Markup.inlineKeyboard([
            [
              Markup.button.callback('📋 Danh sách cảnh báo', 'bbatr_list'),
              Markup.button.callback('📊 Bảng BB+ATR M5', 'bbatr_menu'),
            ],
          ]),
        );
      }

      // Trường hợp 7: Xem bảng thông số cho một mã cụ thể (VD: /bbatr btc hoặc /bbatr eth 15m)
      const targetSymbol = parts[0];
      const targetTf = parts[1] ? this.bbAtrService.normalizeTimeframe(parts[1]) : 'M5';

      try {
        await ctx.sendChatAction('typing');
        const { text: msgText, keyboard } = await this.renderBbAtrDashboardView(chatId, targetSymbol, targetTf);
        return ctx.replyWithHTML(msgText, keyboard);
      } catch (e: any) {
        return ctx.replyWithHTML(`⚠️ Lỗi: ${e.message}`);
      }
    });

    // Action: Mở Dashboard BB+ATR chính
    this.bot.action('bbatr_menu', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      await ctx.answerCbQuery();
      const { text, keyboard } = await this.renderBbAtrDashboardView(chatId, 'XAU', 'M5');
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(text, keyboard);
      }
    });

    // Action: Làm mới / Xem Dashboard theo mã & timeframe
    this.bot.action(/^bbatr_view:([A-Za-z0-9]+):([A-Za-z0-9]+)$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const symbol = ctx.match[1];
      const tf = ctx.match[2];
      await ctx.answerCbQuery('🔄 Đang cập nhật dữ liệu nến...');
      try {
        const { text, keyboard } = await this.renderBbAtrDashboardView(chatId, symbol, tf);
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e: any) {
        await ctx.answerCbQuery(`⚠️ Lỗi: ${e.message}`, { show_alert: true });
      }
    });

    // Action: Bật/Tắt cảnh báo tự động XAU M5
    this.bot.action('bbatr_toggle', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const next = await this.bbAtrService.toggleUserBbAtrEnabled(chatId);
      await ctx.answerCbQuery(next ? '🔔 Đã BẬT cảnh báo tự động XAU M5!' : '🔕 Đã TẮT cảnh báo tự động XAU M5!');
      const { text, keyboard } = await this.renderBbAtrDashboardView(chatId, 'XAU', 'M5');
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(text, keyboard);
      }
    });

    // Action: Bật/Tắt Cảnh báo Tier 2 từ BB Dashboard
    this.bot.action('bbatr_toggle_tier2', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const isNowOn = await this.bbAtrService.toggleUserTier2Enabled(chatId);
      await this.smcService.setTier2(chatId, isNowOn);
      await ctx.answerCbQuery(
        isNowOn
          ? '🔥 Đã BẬT cảnh báo Tier 3 (BB ± ATR + Nến rút râu M5)!'
          : '🔕 Đã TẮT cảnh báo Tier 3 (BB ± ATR + Nến rút râu M5)!',
      );
      const { text, keyboard } = await this.renderBbAtrDashboardView(chatId, 'XAU', 'M5');
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(text, keyboard);
      }
    });

    // Action: Xem danh sách cảnh báo cá nhân
    this.bot.action('bbatr_list', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      await ctx.answerCbQuery('🔄 Đang tải danh sách cảnh báo...');
      const { text, keyboard } = await this.renderBbAtrAlertsView(chatId);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(text, keyboard);
      }
    });

    // Action: Xóa 1 cảnh báo cá nhân
    this.bot.action(/^bbatr_del:(\d+)$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const alertId = parseInt(ctx.match[1], 10);
      const res = await this.bbAtrService.deleteAlert(chatId, alertId);
      await ctx.answerCbQuery(res.success ? `🗑 Đã xóa #${alertId}` : '⚠️ Không thể xóa');
      const { text, keyboard } = await this.renderBbAtrAlertsView(chatId);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(text, keyboard);
      }
    });

    // Action: Xóa tất cả cảnh báo cá nhân
    this.bot.action('bbatr_clear', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const res = await this.bbAtrService.clearUserAlerts(chatId);
      await ctx.answerCbQuery(`🗑 Đã xóa ${res.count} cảnh báo!`);
      const { text, keyboard } = await this.renderBbAtrAlertsView(chatId);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(text, keyboard);
      }
    });

    // Action: Cài nhanh cảnh báo cho 1 mã
    this.bot.action(/^bbatr_add:([A-Za-z0-9]+)$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      const username = ctx.from?.username || ctx.from?.first_name;
      if (!chatId) return;
      const symbol = ctx.match[1];
      await ctx.answerCbQuery(`⏳ Đang tạo cảnh báo cho ${symbol}...`);
      const res = await this.bbAtrService.createBbAtrAlert({
        chatId,
        username,
        symbol,
        timeframe: 'M5',
      });
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📋 Danh sách cảnh báo', 'bbatr_list'),
          Markup.button.callback('📊 Bảng BB+ATR M5', 'bbatr_menu'),
        ],
      ]);
      try {
        await ctx.editMessageText(res.message, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(res.message, keyboard);
      }
    });

    // Action: Chọn bộ lọc xu hướng Bias từ nút bấm
    this.bot.action(/^bbatr_bias:(BOTH|BUY_ONLY|SELL_ONLY)$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const bias = ctx.match[1] as 'BOTH' | 'BUY_ONLY' | 'SELL_ONLY';
      await this.bbAtrService.setUserBias(chatId, bias);

      const labelMap = {
        BUY_ONLY: '🟢 Đã chọn: CHỈ CANH BUY (Bỏ qua Sell)',
        SELL_ONLY: '🔴 Đã chọn: CHỈ CANH SELL (Bỏ qua Buy)',
        BOTH: '⚖️ Đã chọn: CẢ 2 CHIỀU (Buy & Sell)',
      };
      await ctx.answerCbQuery(labelMap[bias]);

      const { text, keyboard } = await this.renderBbAtrDashboardView(chatId, 'XAU', 'M5');
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(text, keyboard);
      }
    });

    // Action: Xem hướng dẫn chiến lược
    this.bot.action('bbatr_help', async (ctx) => {
      await ctx.answerCbQuery();
      const helpText = this.renderBbAtrHelpText();
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📊 Quay lại Bảng BB+ATR M5', 'bbatr_menu')],
      ]);
      try {
        await ctx.editMessageText(helpText, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(helpText, keyboard);
      }
    });

    // 8. Lệnh /nwe - Nadaraya-Watson Envelope (NWE) + Dynamic S/R Dashboard
    this.bot.command(['nwe', 'envelope'], async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const username = ctx.from?.username || ctx.from?.first_name;
      await this.watchlistService.registerUser(chatId, username);
      this.smcService.registerActiveChat(chatId);

      const text = ctx.message.text.trim();
      const argsStr = text.replace(/^\/(nwe|envelope)(@\w+)?\s*/i, '').trim();
      const parts = argsStr.split(/\s+/).filter(Boolean);

      // Nếu có đối số on / off: /nwe on, /nwe off
      if (parts.length > 0) {
        const firstArg = parts[0].toLowerCase();
        if (['on', 'bat', 'enable'].includes(firstArg)) {
          await this.smcService.setNwe(chatId, true);
          const { text: msgText, keyboard } = await this.renderNweDashboardView(chatId, 'M15');
          return ctx.replyWithHTML(`🔔 <b>ĐÃ BẬT</b> cảnh báo Nadaraya-Watson Envelope!\n\n${msgText}`, keyboard);
        }
        if (['off', 'tat', 'disable'].includes(firstArg)) {
          await this.smcService.setNwe(chatId, false);
          const { text: msgText, keyboard } = await this.renderNweDashboardView(chatId, 'M15');
          return ctx.replyWithHTML(`🔕 <b>ĐÃ TẮT</b> cảnh báo Nadaraya-Watson Envelope!\n\n${msgText}`, keyboard);
        }

        const argUpper = parts[0].toUpperCase() as SmcTimeframe;
        if (this.smcService.supportedTimeframes.includes(argUpper)) {
          await ctx.sendChatAction('typing');
          try {
            const { text: msgText, keyboard } = await this.renderNweDashboardView(chatId, argUpper);
            return ctx.replyWithHTML(msgText, keyboard);
          } catch (e: any) {
            return ctx.replyWithHTML(`⚠️ Lỗi phân tích NWE ${argUpper}: ${e.message}`);
          }
        }
      }

      // Mặc định: Mở Dashboard NWE M15
      await ctx.sendChatAction('typing');
      try {
        const { text: msgText, keyboard } = await this.renderNweDashboardView(chatId, 'M15');
        return ctx.replyWithHTML(msgText, keyboard);
      } catch (err: any) {
        return ctx.replyWithHTML(`⚠️ Lỗi lấy dữ liệu NWE: ${err.message}`);
      }
    });

    // 9. Lệnh /ob hoặc /smc - SMC Order Blocks (Demand & Supply) Dashboard
    this.bot.command(['ob', 'smc', 'orderblock', 'zone'], async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const username = ctx.from?.username || ctx.from?.first_name;
      await this.watchlistService.registerUser(chatId, username);
      this.smcService.registerActiveChat(chatId);

      const text = ctx.message.text.trim();
      const argsStr = text.replace(/^\/(ob|smc|orderblock|zone)(@\w+)?\s*/i, '').trim();
      const parts = argsStr.split(/\s+/).filter(Boolean);

      // Nếu có đối số on / off: /ob on, /ob off
      if (parts.length > 0) {
        const firstArg = parts[0].toLowerCase();
        if (['on', 'bat', 'enable'].includes(firstArg)) {
          await this.smcService.setSmc(chatId, true);
          const { text: msgText, keyboard } = await this.renderObDashboardView(chatId, 'M15');
          return ctx.replyWithHTML(`🔔 <b>ĐÃ BẬT</b> cảnh báo SMC Order Blocks (Vùng Cung/Cầu)!\n\n${msgText}`, keyboard);
        }
        if (['off', 'tat', 'disable'].includes(firstArg)) {
          await this.smcService.setSmc(chatId, false);
          const { text: msgText, keyboard } = await this.renderObDashboardView(chatId, 'M15');
          return ctx.replyWithHTML(`🔕 <b>ĐÃ TẮT</b> cảnh báo SMC Order Blocks (Vùng Cung/Cầu)!\n\n${msgText}`, keyboard);
        }

        const argUpper = parts[0].toUpperCase() as SmcTimeframe;
        if (this.smcService.supportedTimeframes.includes(argUpper)) {
          await ctx.sendChatAction('typing');
          try {
            const { text: msgText, keyboard } = await this.renderObDashboardView(chatId, argUpper);
            return ctx.replyWithHTML(msgText, keyboard);
          } catch (e: any) {
            return ctx.replyWithHTML(`⚠️ Lỗi phân tích Order Block ${argUpper}: ${e.message}`);
          }
        }
      }

      // Mặc định: Mở Dashboard OB M15
      await ctx.sendChatAction('typing');
      try {
        const { text: msgText, keyboard } = await this.renderObDashboardView(chatId, 'M15');
        return ctx.replyWithHTML(msgText, keyboard);
      } catch (err: any) {
        return ctx.replyWithHTML(`⚠️ Lỗi lấy dữ liệu Order Block: ${err.message}`);
      }
    });

    // 10. Lệnh /tier2 hoặc /tier3 hoặc /sweep - Bật/Tắt riêng Cảnh báo Quét Thanh Khoản VIP (High Probability)
    this.bot.command(['tier2', 'tier3', 'sweep', 'sfp'], async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const username = ctx.from?.username || ctx.from?.first_name;
      await this.watchlistService.registerUser(chatId, username);

      const text = ctx.message.text.trim();
      const parts = text.split(/\s+/).filter(Boolean);
      const arg = (parts[1] || '').toLowerCase();

      let isEnabled: boolean;
      if (['on', 'bat', 'enable'].includes(arg)) {
        isEnabled = true;
      } else if (['off', 'tat', 'disable'].includes(arg)) {
        isEnabled = false;
      } else {
        const current = await this.smcService.getUserSettings(chatId);
        isEnabled = current.tier2AlertEnabled === false;
      }

      await this.smcService.setTier2(chatId, isEnabled);
      await this.bbAtrService.setUserTier2Enabled(chatId, isEnabled);

      const statusBadge = isEnabled ? '🟢 ĐANG BẬT (Ưu tiên phát cảnh báo)' : '⚪ ĐÃ TẮT';
      const msg =
        `🔥 <b>CÀI ĐẶT CẢNH BÁO QUÉT THANH KHOẢN (TIER 3 / SFP):</b> <b>${statusBadge}</b>\n\n` +
        (isEnabled
          ? '<i>👉 Khi xuất hiện cú quét râu thanh khoản M15 hợp lưu cùng BB+ATR hoặc NWE+SMC, bot sẽ NGAY LẬP TỨC gửi cảnh báo Tier 3 (🔥🔥🔥) cho bạn (kể cả khi bạn tắt cảnh báo thông thường)!</i>'
          : '<i>👉 Bạn đã chủ động TẮT cảnh báo Quét Thanh Khoản. Bot sẽ không gửi tín hiệu quét râu cho bạn nữa.</i>');

      return ctx.replyWithHTML(
        msg,
        Markup.inlineKeyboard([
          [Markup.button.callback(isEnabled ? '🔕 Tắt Cảnh Báo Quét TK' : '🔔 Bật Cảnh Báo Quét TK', 'smc_toggle_tier2')],
          [
            Markup.button.callback('📊 Bảng BB+ATR', 'bbatr_menu'),
            Markup.button.callback('🌊 Bảng NWE', 'nwe_view:M15'),
            Markup.button.callback('🧱 Bảng Order Block', 'ob_view:M15'),
          ],
        ]),
      );
    });

    // ==================== CÁC ACTIONS CHO BẢNG NWE DASHBOARD ====================

    // Action: Xem / Làm mới Dashboard NWE theo khung
    this.bot.action(/^nwe_view:([A-Za-z0-9]+)$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const tf = ctx.match[1] as SmcTimeframe;
      await ctx.answerCbQuery(`🔄 Đang cập nhật NWE ${tf}...`);
      try {
        const { text, keyboard } = await this.renderNweDashboardView(chatId, tf);
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e: any) {
        await ctx.answerCbQuery(`⚠️ Lỗi: ${e.message}`, { show_alert: true });
      }
    });

    // Action: Bật/Tắt Cảnh báo Nadaraya-Watson Envelope (NWE)
    this.bot.action(/^nwe_toggle(:([A-Za-z0-9]+))?$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const tf = (ctx.match[2] as SmcTimeframe) || 'M15';
      const updated = await this.smcService.toggleNwe(chatId);
      await ctx.answerCbQuery(
        updated.nweAlertEnabled
          ? '🌊 Đã BẬT cảnh báo Nadaraya-Watson Envelope!'
          : '🔕 Đã TẮT cảnh báo Nadaraya-Watson Envelope!',
      );
      try {
        const { text, keyboard } = await this.renderNweDashboardView(chatId, tf);
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Bật/Tắt khung thời gian nhận tin NWE
    this.bot.action(/^nwe_tf:([A-Za-z0-9]+)(:([A-Za-z0-9]+))?$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const tf = ctx.match[1] as SmcTimeframe;
      const currentViewTf = (ctx.match[3] as SmcTimeframe) || tf;
      const updated = await this.smcService.toggleNweTimeframe(chatId, tf);
      const isEnabled = (updated.nweTimeframes || []).includes(tf);
      const label = this.smcService.timeframeLabels[tf] || tf;
      await ctx.answerCbQuery(isEnabled ? `✅ Đã BẬT cảnh báo NWE ${label}` : `❌ Đã TẮT cảnh báo NWE ${label}`);
      try {
        const { text, keyboard } = await this.renderNweDashboardView(chatId, currentViewTf);
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Bật/Tắt Tier 2 từ NWE Dashboard
    this.bot.action(/^nwe_toggle_tier2(:([A-Za-z0-9]+))?$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const currentViewTf = (ctx.match[2] as SmcTimeframe) || 'M15';
      const updated = await this.smcService.toggleTier2(chatId);
      await this.bbAtrService.setUserTier2Enabled(chatId, updated.tier2AlertEnabled !== false);
      const isNowOn = updated.tier2AlertEnabled !== false;
      await ctx.answerCbQuery(
        isNowOn
          ? '🔥 Đã BẬT cảnh báo Tier 3 VIP (NWE H1 + OB + Rút râu M15)!'
          : '🔕 Đã TẮT cảnh báo Tier 3 VIP (NWE H1 + OB + Rút râu M15)!',
      );
      try {
        const { text, keyboard } = await this.renderNweDashboardView(chatId, currentViewTf);
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Hướng dẫn NWE
    this.bot.action('nwe_help', async (ctx) => {
      await ctx.answerCbQuery();
      const helpText = `
🌊 <b>HƯỚNG DẪN CHIẾN LƯỢC: NADARAYA-WATSON ENVELOPE (NWE) + DYNAMIC S/R</b>
━━━━━━━━━━━━━━━━━━━━━
Dải Nadaraya-Watson Envelope sử dụng thuật toán hồi quy hạt nhân phi tham số (Non-parametric Kernel Regression) với băng thông h=8, mult=3 để bám sát và phát hiện cực trị biên dao động giá.

📌 <b>Nguyên lý giao dịch:</b>
• 🔴 <b>Dải Trên (Upper Band):</b> Vùng quá mua cực hạn (Extreme Overbought). Giá chạm hoặc vượt dải trên kết hợp cản động kháng cự là tín hiệu đảo chiều giảm -> <b>Canh SELL</b>.
• 🟢 <b>Dải Dưới (Lower Band):</b> Vùng quá bán cực hạn (Extreme Oversold). Giá chạm hoặc thủng dải dưới kết hợp cản động hỗ trợ là tín hiệu đảo chiều tăng -> <b>Canh BUY</b>.
• 🛡 <b>Dynamic S/R:</b> Các đường hỗ trợ / kháng cự biến thiên theo cấu trúc sóng của thị trường.

🔔 <b>Hệ thống 3 tầng Cảnh báo SMC + NWE:</b>
• 🔔 <b>TIER 1:</b> Chạm NWE đơn lẻ hoặc Order Block đơn lẻ trên từng khung thời gian.
• 🔥🔥 <b>TIER 2 (MTF Confluence):</b> Chạm biên <b>NWE H1</b> ĐỒNG THỜI giao cắt ít nhất 1 khối <b>Order Block (M15, M30, H1, H4)</b>.
• 🔥🔥🔥 <b>TIER 3 (VIP):</b> Thỏa Tier 2 CỘNG VỚI xuất hiện <b>nến rút râu từ chối khung M15</b> trong vùng hợp lưu (lọc chuẩn theo ATR M15).
• Khung thời gian tối ưu cho XAU/USD: <b>M15 & H1</b>.
      `.trim();
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📊 Quay lại Bảng NWE M15', 'nwe_view:M15')],
      ]);
      try {
        await ctx.editMessageText(helpText, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(helpText, keyboard);
      }
    });

    // Action: Menu NWE
    this.bot.action('nwe_menu', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      await ctx.answerCbQuery();
      try {
        const { text, keyboard } = await this.renderNweDashboardView(chatId, 'M15');
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // ==================== CÁC ACTIONS CHO BẢNG ORDER BLOCK DASHBOARD ====================

    // Action: Xem / Làm mới Dashboard OB theo khung
    this.bot.action(/^ob_view:([A-Za-z0-9]+)$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const tf = ctx.match[1] as SmcTimeframe;
      await ctx.answerCbQuery(`🔄 Đang cập nhật Order Block ${tf}...`);
      try {
        const { text, keyboard } = await this.renderObDashboardView(chatId, tf);
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e: any) {
        await ctx.answerCbQuery(`⚠️ Lỗi: ${e.message}`, { show_alert: true });
      }
    });

    // Action: Bật/Tắt Cảnh báo Order Block (SMC / Demand & Supply)
    this.bot.action(/^ob_toggle(:([A-Za-z0-9]+))?$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const tf = (ctx.match[2] as SmcTimeframe) || 'M15';
      const updated = await this.smcService.toggleSmc(chatId);
      await ctx.answerCbQuery(
        updated.smcAlertEnabled
          ? '🧱 Đã BẬT cảnh báo Order Block (Vùng Cung/Cầu)!'
          : '🔕 Đã TẮT cảnh báo Order Block (Vùng Cung/Cầu)!',
      );
      try {
        const { text, keyboard } = await this.renderObDashboardView(chatId, tf);
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Bật/Tắt khung thời gian nhận tin Order Block
    this.bot.action(/^ob_tf:([A-Za-z0-9]+)(:([A-Za-z0-9]+))?$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const tf = ctx.match[1] as SmcTimeframe;
      const currentViewTf = (ctx.match[3] as SmcTimeframe) || tf;
      const updated = await this.smcService.toggleSmcTimeframe(chatId, tf);
      const isEnabled = (updated.smcTimeframes || []).includes(tf);
      const label = this.smcService.timeframeLabels[tf] || tf;
      await ctx.answerCbQuery(isEnabled ? `✅ Đã BẬT cảnh báo Order Block ${label}` : `❌ Đã TẮT cảnh báo Order Block ${label}`);
      try {
        const { text, keyboard } = await this.renderObDashboardView(chatId, currentViewTf);
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Bật/Tắt Tier 2 từ OB Dashboard
    this.bot.action(/^ob_toggle_tier2(:([A-Za-z0-9]+))?$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const currentViewTf = (ctx.match[2] as SmcTimeframe) || 'M15';
      const updated = await this.smcService.toggleTier2(chatId);
      await this.bbAtrService.setUserTier2Enabled(chatId, updated.tier2AlertEnabled !== false);
      const isNowOn = updated.tier2AlertEnabled !== false;
      await ctx.answerCbQuery(
        isNowOn
          ? '🔥 Đã BẬT cảnh báo Tier 3 VIP (NWE H1 + OB + Rút râu M15)!'
          : '🔕 Đã TẮT cảnh báo Tier 3 VIP (NWE H1 + OB + Rút râu M15)!',
      );
      try {
        const { text, keyboard } = await this.renderObDashboardView(chatId, currentViewTf);
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Hướng dẫn Order Block
    this.bot.action('ob_help', async (ctx) => {
      await ctx.answerCbQuery();
      const helpText = `
🧱 <b>HƯỚNG DẪN CHIẾN LƯỢC: SMC ORDER BLOCKS (CUNG & CẦU)</b>
━━━━━━━━━━━━━━━━━━━━━
Order Block (OB) là các vùng tích lũy lệnh lớn của tổ chức tài chính/cá mập (Smart Money) trước khi tạo ra cú dịch chuyển giá đột phá (BOS/ChoCH).

📌 <b>Nguyên lý giao dịch:</b>
• 🔴 <b>Vùng Cung (Supply Zone / Bearish OB):</b> Cây nến tăng cuối cùng trước cú xả mạnh phá vỡ cấu trúc đáy. Khi giá hồi về (Retest) vùng này -> <b>Ưu tiên Canh SELL</b>.
• 🟢 <b>Vùng Cầu (Demand Zone / Bullish OB):</b> Cây nến giảm cuối cùng trước cú bơm mạnh phá vỡ cấu trúc đỉnh. Khi giá hồi về vùng này -> <b>Ưu tiên Canh BUY</b>.
• ❌ <b>Triệt tiêu (Mitigation):</b> Một vùng OB khi bị giá đâm xuyên qua thân nến sẽ bị coi là đã triệt tiêu và bot sẽ tự động loại bỏ.

🔥 <b>Hệ thống phân cấp SMC + NWE (Tier 1 → Tier 2 → Tier 3 VIP):</b>
• 🔔 <b>TIER 1:</b> Chạm Order Block hoặc biên NWE đơn lẻ từng khung.
• 🔥🔥 <b>TIER 2 (MTF Confluence):</b> Chạm biên <b>NWE H1</b> ĐỒNG THỜI giao cắt ít nhất 1 khối <b>OB thuộc M15, M30, H1 hoặc H4</b>.
• 🔥🔥🔥 <b>TIER 3 (VIP):</b> Thỏa Tier 2 CỘNG VỚI xuất hiện <b>nến rút râu từ chối khung M15</b> bên trong vùng hợp lưu OB (không phá vỡ mép ngoài OB, lọc chuẩn theo ATR M15)!
      `.trim();
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📊 Quay lại Bảng Order Block M15', 'ob_view:M15')],
      ]);
      try {
        await ctx.editMessageText(helpText, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(helpText, keyboard);
      }
    });

    // Action: Menu OB
    this.bot.action('ob_menu', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      await ctx.answerCbQuery();
      try {
        const { text, keyboard } = await this.renderObDashboardView(chatId, 'M15');
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Mở menu cài đặt SMC & NWE
    this.bot.action('smc_open_settings', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      await ctx.answerCbQuery();
      const settings = await this.smcService.getUserSettings(chatId);
      const { text, keyboard } = this.renderSmcSettingsMenu(settings);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {
        await ctx.replyWithHTML(text, keyboard);
      }
    });

    // Action: Bật/Tắt Cảnh báo Nadaraya-Watson Envelope (NWE)
    this.bot.action('smc_toggle_nwe', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const updated = await this.smcService.toggleNwe(chatId);
      await ctx.answerCbQuery(
        updated.nweAlertEnabled
          ? '🌊 Đã BẬT cảnh báo Nadaraya-Watson Envelope!'
          : '🔕 Đã TẮT cảnh báo Nadaraya-Watson Envelope!',
      );
      const { text, keyboard } = this.renderSmcSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Bật/Tắt Cảnh báo Order Block (SMC / Demand & Supply)
    this.bot.action('smc_toggle_ob', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const updated = await this.smcService.toggleSmc(chatId);
      await ctx.answerCbQuery(
        updated.smcAlertEnabled
          ? '🧱 Đã BẬT cảnh báo Order Block (Vùng Cung/Cầu)!'
          : '🔕 Đã TẮT cảnh báo Order Block (Vùng Cung/Cầu)!',
      );
      const { text, keyboard } = this.renderSmcSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Bật/Tắt Cảnh báo Quét Thanh Khoản Tier 2 (High Probability)
    this.bot.action('smc_toggle_tier2', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const updated = await this.smcService.toggleTier2(chatId);
      await this.bbAtrService.setUserTier2Enabled(chatId, updated.tier2AlertEnabled !== false);
      const isNowOn = updated.tier2AlertEnabled !== false;
      await ctx.answerCbQuery(
        isNowOn
          ? '🔥 Đã BẬT cảnh báo Tier 2 (Quét thanh khoản)!'
          : '🔕 Đã TẮT cảnh báo Tier 2 (Quét thanh khoản)!',
      );
      const { text, keyboard } = this.renderSmcSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Bật/Tắt một khung thời gian cụ thể (M5, M15, M30, H1, H4, D1)
    this.bot.action(/^smc_toggle_tf:([A-Za-z0-9]+)$/, async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const tf = ctx.match[1] as SmcTimeframe;
      const updated = await this.smcService.toggleTimeframe(chatId, tf);
      const isEnabled = updated.timeframes.includes(tf);
      const label = this.smcService.timeframeLabels[tf] || tf;

      await ctx.answerCbQuery(isEnabled ? `✅ Đã BẬT khung: ${label}` : `❌ Đã TẮT khung: ${label}`);
      const { text, keyboard } = this.renderSmcSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Bật tất cả các khung thời gian
    this.bot.action('smc_set_all_tf', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const updated = await this.smcService.setAllTimeframes(chatId);
      await ctx.answerCbQuery('🔔 Đã BẬT tất cả 6 khung thời gian (M5 -> D1)!');
      const { text, keyboard } = this.renderSmcSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Đặt về các khung khuyên dùng (M5, M15, H1, H4)
    this.bot.action('smc_set_default_tf', async (ctx) => {
      const chatId = ctx.chat?.id.toString();
      if (!chatId) return;
      const updated = await this.smcService.setDefaultTimeframes(chatId);
      await ctx.answerCbQuery('🎯 Đã khôi phục khung thời gian khuyên dùng (M5, M15, H1, H4)!');
      const { text, keyboard } = this.renderSmcSettingsMenu(updated);
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (e) {}
    });

    // Action: Xem trực tiếp bảng phân tích SMC & NWE cho 1 khung thời gian
    this.bot.action(/^smc_view:([A-Za-z0-9]+)$/, async (ctx) => {
      const tf = ctx.match[1] as SmcTimeframe;
      await ctx.answerCbQuery(`🔄 Đang phân tích NWE & SMC ${tf}...`);
      try {
        const analysis = await this.smcService.analyzeTimeframe(tf, true);
        const msg = this.smcService.renderDashboard(analysis);
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('🔄 Làm Mới Dữ Liệu', `smc_view:${tf}`),
            Markup.button.callback('⚙️ Cài Đặt Bật/Tắt', 'smc_open_settings'),
          ],
          [
            Markup.button.callback('M5', 'smc_view:M5'),
            Markup.button.callback('M15', 'smc_view:M15'),
            Markup.button.callback('M30', 'smc_view:M30'),
            Markup.button.callback('H1', 'smc_view:H1'),
            Markup.button.callback('H4', 'smc_view:H4'),
            Markup.button.callback('D1', 'smc_view:D1'),
          ],
        ]);
        try {
          await ctx.editMessageText(msg, { parse_mode: 'HTML', ...keyboard });
        } catch (e) {
          await ctx.replyWithHTML(msg, keyboard);
        }
      } catch (e: any) {
        await ctx.replyWithHTML(`⚠️ Không thể nạp dữ liệu SMC ${tf}: ${e.message}`);
      }
    });
  }

  /**
   * Phương thức hỗ trợ gửi thông báo tự động từ Cron job tới Telegram Chat (kèm nút bấm nếu có)
   * Tự động chia nhỏ tin nhắn nếu nội dung vượt quá giới hạn Telegram
   */
  async sendMessage(chatId: string, message: string, keyboard?: any) {
    if (!this.bot) return;
    try {
      if (message.length <= 4000) {
        if (keyboard) {
          await this.bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML', ...keyboard });
        } else {
          await this.bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
        }
      } else {
        // Tách nhỏ tin nhắn theo từng đoạn văn bản
        const chunks = this.splitMessageIntoChunks(message, 3800);
        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          if (isLast && keyboard) {
            await this.bot.telegram.sendMessage(chatId, chunks[i], { parse_mode: 'HTML', ...keyboard });
          } else {
            await this.bot.telegram.sendMessage(chatId, chunks[i], { parse_mode: 'HTML' });
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Lỗi khi gửi tin nhắn tới Telegram Chat ID ${chatId}: ${error.message}`);
    }
  }

  /**
   * Chia nhỏ chuỗi tin nhắn dài an toàn theo dấu xuống dòng
   */
  private splitMessageIntoChunks(text: string, maxChunkSize = 3800): string[] {
    const chunks: string[] = [];
    let current = '';

    const lines = text.split('\n');
    for (const line of lines) {
      if ((current + '\n' + line).length > maxChunkSize) {
        if (current.trim()) chunks.push(current.trim());
        current = line;
      } else {
        current += (current ? '\n' : '') + line;
      }
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    return chunks.length > 0 ? chunks : [text];
  }

  /**
   * Gửi ảnh kèm caption tới Telegram chat
   */
  async sendPhoto(chatId: string, photoUrl: string, caption?: string) {
    if (!this.bot) return;
    try {
      await this.bot.telegram.sendPhoto(chatId, { url: photoUrl }, {
        caption: (caption || '').slice(0, 1000),
        parse_mode: 'HTML',
      });
    } catch (error) {
      this.logger.error(`Lỗi khi gửi ảnh tới Telegram Chat ID ${chatId}: ${error.message}`);
    }
  }

  /**
   * Tạo nội dung giao diện HTML và inline keyboard cho menu cài đặt bộ lọc vĩ mô
   */
  private renderMacroSettingsMenu(levels: number[]) {
    const isHigh = levels.includes(1);
    const isMedium = levels.includes(0);
    const isLow = levels.includes(-1);

    const activeCount = levels.length;
    let summaryTag = '';
    if (activeCount === 3) {
      summaryTag = '🔔 <b>BẬT TẤT CẢ (3/3 mức)</b>';
    } else if (activeCount === 0) {
      summaryTag = '🔕 <b>ĐANG TẮT TẤT CẢ (Tạm ngưng nhận tin vĩ mô)</b>';
    } else {
      summaryTag = `🎯 <b>ĐANG BẬT ${activeCount}/3 mức</b>`;
    }

    const text = `
⚙️ <b>CÀI ĐẶT BỘ LỌC CẢNH BÁO VĨ MÔ TỨC THÌ</b>
${summaryTag}

<i>Chọn các mức độ ảnh hưởng của sự kiện kinh tế bạn muốn nhận thông báo tức thì (Real-time Instant Alert) khi vừa công bố số liệu Thực tế (Actual):</i>

• ⭐⭐⭐ <b>Cao (High Impact):</b> ${isHigh ? '🟢 <b>BẬT</b>' : '⚪ <b>TẮT</b>'}
  <i>(Fed lãi suất, CPI, Non-Farm Payrolls NFP, GDP...)</i>

• ⭐⭐ <b>Trung bình (Medium Impact):</b> ${isMedium ? '🟢 <b>BẬT</b>' : '⚪ <b>TẮT</b>'}
  <i>(PPI, Đơn trợ cấp thất nghiệp Jobless claims, Doanh số bán lẻ, PMI...)</i>

• ⭐ <b>Thấp (Low Impact):</b> ${isLow ? '🟢 <b>BẬT</b>' : '⚪ <b>TẮT</b>'}
  <i>(Đấu thầu trái phiếu, các khảo sát nhỏ...)</i>

💡 <i>Nhấn vào các nút bên dưới để Bật/Tắt từng mức độ theo mong muốn:</i>
    `.trim();

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          `${isHigh ? '✅' : '❌'} ⭐⭐⭐ Cao (High Impact)`,
          'macro_toggle:1',
        ),
      ],
      [
        Markup.button.callback(
          `${isMedium ? '✅' : '❌'} ⭐⭐ Trung bình (Medium Impact)`,
          'macro_toggle:0',
        ),
      ],
      [
        Markup.button.callback(
          `${isLow ? '✅' : '❌'} ⭐ Thấp (Low Impact)`,
          'macro_toggle:-1',
        ),
      ],
      [
        Markup.button.callback('🔔 Bật tất cả', 'macro_set:all'),
        Markup.button.callback('🎯 Mặc định (Cao + TB)', 'macro_set:default'),
      ],
      [
        Markup.button.callback('📅 Xem lịch kinh tế hôm nay', 'macro_view_today'),
      ],
    ]);

    return { text, keyboard };
  }

  /**
   * Tạo nội dung giao diện HTML và inline keyboard cho menu cài đặt cảnh báo RSI Vàng XAU/USD
   */
  private renderXauSettingsMenu(settings: UserXauSettings) {
    const isMasterOn = settings.enabled;
    const tfs = settings.timeframes;

    const isM1 = tfs.includes('M1');
    const isM5 = tfs.includes('M5');
    const isM15 = tfs.includes('M15');
    const isM30 = tfs.includes('M30');
    const isH1 = tfs.includes('H1');
    const isH4 = tfs.includes('H4');
    const isD1 = tfs.includes('D1');

    const isPreset70 = settings.overboughtRsi === 70 && settings.oversoldRsi === 30;
    const isPreset75 = settings.overboughtRsi === 75 && settings.oversoldRsi === 25;
    const isPreset80 = settings.overboughtRsi === 80 && settings.oversoldRsi === 20;

    let statusHeader = '';
    if (!isMasterOn) {
      statusHeader = '🔕 <b>TRẠNG THÁI: TẮT CẢNH BÁO</b> (Không nhận thông báo RSI)';
    } else {
      statusHeader = `🔔 <b>TRẠNG THÁI: ĐANG BẬT</b> (${tfs.length}/7 khung được kích hoạt)`;
    }

    let text = `⚙️ <b>CÀI ĐẶT CẢNH BÁO RSI VÀNG (XAU/USD)</b>\n`;
    text += `${statusHeader}\n\n`;
    text += `<i>Hệ thống tự động quét và gửi tin nhắn tức thì khi RSI của XAU/USD chạm hoặc vượt vùng Quá Mua / Quá Bán trên các khung thời gian bạn chọn:</i>\n\n`;

    text += `⏳ <b>Các khung thời gian đang kích hoạt:</b>\n`;
    text += `• M1 (1 Phút): ${isM1 ? '🟢 Bật' : '⚪ Tắt'}\n`;
    text += `• M5 (5 Phút): ${isM5 ? '🟢 Bật' : '⚪ Tắt'}\n`;
    text += `• M15 (15 Phút): ${isM15 ? '🟢 Bật' : '⚪ Tắt'}\n`;
    text += `• M30 (30 Phút): ${isM30 ? '🟢 Bật' : '⚪ Tắt'}\n`;
    text += `• H1 (1 Giờ): ${isH1 ? '🟢 Bật' : '⚪ Tắt'}\n`;
    text += `• H4 (4 Giờ): ${isH4 ? '🟢 Bật' : '⚪ Tắt'}\n`;
    text += `• D1 (1 Ngày): ${isD1 ? '🟢 Bật' : '⚪ Tắt'}\n\n`;

    text += `🎯 <b>Ngưỡng kích hoạt:</b> Quá Mua ≥ <code>${settings.overboughtRsi}</code> | Quá Bán ≤ <code>${settings.oversoldRsi}</code>\n\n`;
    text += `💡 <i>Bấm vào các nút bên dưới để Bật/Tắt từng khung hoặc chọn bộ ngưỡng nhanh:</i>`;

    const keyboard = Markup.inlineKeyboard([
      // Hàng 1: Nút Master On/Off
      [
        Markup.button.callback(
          isMasterOn ? '🔕 TẮT TẤT CẢ CẢNH BÁO' : '🔔 BẬT NHẬN CẢNH BÁO',
          'xau_toggle_master',
        ),
      ],
      // Hàng 2: Khung ngắn hạn
      [
        Markup.button.callback(`${isM1 ? '✅' : '❌'} M1 (1p)`, 'xau_toggle_tf:M1'),
        Markup.button.callback(`${isM5 ? '✅' : '❌'} M5 (5p)`, 'xau_toggle_tf:M5'),
        Markup.button.callback(`${isM15 ? '✅' : '❌'} M15 (15p)`, 'xau_toggle_tf:M15'),
      ],
      // Hàng 3: Khung trung & dài hạn
      [
        Markup.button.callback(`${isM30 ? '✅' : '❌'} M30`, 'xau_toggle_tf:M30'),
        Markup.button.callback(`${isH1 ? '✅' : '❌'} H1 (1h)`, 'xau_toggle_tf:H1'),
        Markup.button.callback(`${isH4 ? '✅' : '❌'} H4 (4h)`, 'xau_toggle_tf:H4'),
        Markup.button.callback(`${isD1 ? '✅' : '❌'} D1 (1d)`, 'xau_toggle_tf:D1'),
      ],
      // Hàng 4: Chọn ngưỡng RSI
      [
        Markup.button.callback(`${isPreset70 ? '🔘' : '⚪'} 70 / 30 (Chuẩn)`, 'xau_set_threshold:70_30'),
        Markup.button.callback(`${isPreset75 ? '🔘' : '⚪'} 75 / 25 (Lọc nhiễu)`, 'xau_set_threshold:75_25'),
        Markup.button.callback(`${isPreset80 ? '🔘' : '⚪'} 80 / 20 (Cực trị)`, 'xau_set_threshold:80_20'),
      ],
      // Hàng 5: Nút thiết lập nhanh
      [
        Markup.button.callback('🔔 Bật tất cả 7 khung', 'xau_set_all_tf'),
        Markup.button.callback('🎯 Khuyên dùng (M15-D1)', 'xau_set_default_tf'),
      ],
      // Hàng 6: Xem bảng giá Vàng
      [Markup.button.callback('📊 Xem bảng giá & RSI Vàng ngay', 'xau_view_overview')],
    ]);

    return { text, keyboard };
  }

  /**
   * Tạo giao diện Dashboard chiến lược Nadaraya-Watson Envelope (NWE + Dynamic S/R)
   */
  private async renderNweDashboardView(
    chatId: string,
    timeframe: SmcTimeframe = 'M15',
  ): Promise<{ text: string; keyboard: any }> {
    const validTf = this.smcService.supportedTimeframes.includes(timeframe) ? timeframe : 'M15';
    const analysis = await this.smcService.analyzeTimeframe(validTf);
    const settings = await this.smcService.getUserSettings(chatId);

    const isNweOn = settings.nweAlertEnabled;
    const nweTfs = settings.nweTimeframes || ['M5', 'M15', 'H1', 'H4'];
    const isTier2On = settings.tier2AlertEnabled !== false;

    const text = this.smcService.renderNweDashboard(analysis, isNweOn, nweTfs, isTier2On);

    const isM5 = nweTfs.includes('M5');
    const isM15 = nweTfs.includes('M15');
    const isM30 = nweTfs.includes('M30');
    const isH1 = nweTfs.includes('H1');
    const isH4 = nweTfs.includes('H4');
    const isD1 = nweTfs.includes('D1');

    const alertToggleBtnText = isNweOn
      ? '🔕 Tắt Cảnh Báo NWE'
      : '🔔 Bật Cảnh Báo NWE';

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Làm Mới Dữ Liệu', `nwe_view:${validTf}`),
        Markup.button.callback(alertToggleBtnText, `nwe_toggle:${validTf}`),
      ],
      [
        Markup.button.callback(validTf === 'M5' ? '✅ 🟡 M5' : '🟡 M5', 'nwe_view:M5'),
        Markup.button.callback(validTf === 'M15' ? '✅ 🟡 M15' : '🟡 M15', 'nwe_view:M15'),
        Markup.button.callback(validTf === 'H1' ? '✅ 🟡 H1' : '🟡 H1', 'nwe_view:H1'),
        Markup.button.callback(validTf === 'H4' ? '✅ 🟡 H4' : '🟡 H4', 'nwe_view:H4'),
        Markup.button.callback(validTf === 'D1' ? '✅ 🟡 D1' : '🟡 D1', 'nwe_view:D1'),
      ],
      [
        Markup.button.callback(`${isM5 ? '✅' : '❌'} Báo M5`, `nwe_tf:M5:${validTf}`),
        Markup.button.callback(`${isM15 ? '✅' : '❌'} Báo M15`, `nwe_tf:M15:${validTf}`),
        Markup.button.callback(`${isM30 ? '✅' : '❌'} Báo M30`, `nwe_tf:M30:${validTf}`),
      ],
      [
        Markup.button.callback(`${isH1 ? '✅' : '❌'} Báo H1`, `nwe_tf:H1:${validTf}`),
        Markup.button.callback(`${isH4 ? '✅' : '❌'} Báo H4`, `nwe_tf:H4:${validTf}`),
        Markup.button.callback(`${isD1 ? '✅' : '❌'} Báo D1`, `nwe_tf:D1:${validTf}`),
      ],
      [
        Markup.button.callback(
          isTier2On ? '🔥 Tier 3 (Rút Râu M15): ✅ BẬT' : '🔥 Tier 3 (Rút Râu M15): ❌ TẮT',
          `nwe_toggle_tier2:${validTf}`,
        ),
        Markup.button.callback('ℹ️ Hướng Dẫn NWE', 'nwe_help'),
      ],
    ]);

    return { text, keyboard };
  }

  /**
   * Tạo giao diện Dashboard chiến lược SMC Order Blocks (Cung & Cầu)
   */
  private async renderObDashboardView(
    chatId: string,
    timeframe: SmcTimeframe = 'M15',
  ): Promise<{ text: string; keyboard: any }> {
    const validTf = this.smcService.supportedTimeframes.includes(timeframe) ? timeframe : 'M15';
    const analysis = await this.smcService.analyzeTimeframe(validTf);
    const settings = await this.smcService.getUserSettings(chatId);

    const isObOn = settings.smcAlertEnabled;
    const obTfs = settings.smcTimeframes || ['M5', 'M15', 'H1', 'H4'];
    const isTier2On = settings.tier2AlertEnabled !== false;

    const text = this.smcService.renderObDashboard(analysis, isObOn, obTfs, isTier2On);

    const isM5 = obTfs.includes('M5');
    const isM15 = obTfs.includes('M15');
    const isM30 = obTfs.includes('M30');
    const isH1 = obTfs.includes('H1');
    const isH4 = obTfs.includes('H4');
    const isD1 = obTfs.includes('D1');

    const alertToggleBtnText = isObOn
      ? '🔕 Tắt Cảnh Báo OB'
      : '🔔 Bật Cảnh Báo OB';

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Làm Mới Dữ Liệu', `ob_view:${validTf}`),
        Markup.button.callback(alertToggleBtnText, `ob_toggle:${validTf}`),
      ],
      [
        Markup.button.callback(validTf === 'M5' ? '✅ 🟡 M5' : '🟡 M5', 'ob_view:M5'),
        Markup.button.callback(validTf === 'M15' ? '✅ 🟡 M15' : '🟡 M15', 'ob_view:M15'),
        Markup.button.callback(validTf === 'H1' ? '✅ 🟡 H1' : '🟡 H1', 'ob_view:H1'),
        Markup.button.callback(validTf === 'H4' ? '✅ 🟡 H4' : '🟡 H4', 'ob_view:H4'),
        Markup.button.callback(validTf === 'D1' ? '✅ 🟡 D1' : '🟡 D1', 'ob_view:D1'),
      ],
      [
        Markup.button.callback(`${isM5 ? '✅' : '❌'} Báo M5`, `ob_tf:M5:${validTf}`),
        Markup.button.callback(`${isM15 ? '✅' : '❌'} Báo M15`, `ob_tf:M15:${validTf}`),
        Markup.button.callback(`${isM30 ? '✅' : '❌'} Báo M30`, `ob_tf:M30:${validTf}`),
      ],
      [
        Markup.button.callback(`${isH1 ? '✅' : '❌'} Báo H1`, `ob_tf:H1:${validTf}`),
        Markup.button.callback(`${isH4 ? '✅' : '❌'} Báo H4`, `ob_tf:H4:${validTf}`),
        Markup.button.callback(`${isD1 ? '✅' : '❌'} Báo D1`, `ob_tf:D1:${validTf}`),
      ],
      [
        Markup.button.callback(
          isTier2On ? '🔥 Tier 3 (Rút Râu M15): ✅ BẬT' : '🔥 Tier 3 (Rút Râu M15): ❌ TẮT',
          `ob_toggle_tier2:${validTf}`,
        ),
        Markup.button.callback('ℹ️ Hướng Dẫn OB', 'ob_help'),
      ],
    ]);

    return { text, keyboard };
  }

  /**
   * Tạo nội dung giao diện HTML và inline keyboard cho menu cài đặt cảnh báo NWE & SMC Order Blocks
   */
  private renderSmcSettingsMenu(settings: UserSmcSettings) {
    const isNweOn = settings.nweAlertEnabled;
    const isSmcOn = settings.smcAlertEnabled;
    const isTier2On = settings.tier2AlertEnabled !== false;
    const tfs = settings.timeframes;

    const isM5 = tfs.includes('M5');
    const isM15 = tfs.includes('M15');
    const isM30 = tfs.includes('M30');
    const isH1 = tfs.includes('H1');
    const isH4 = tfs.includes('H4');
    const isD1 = tfs.includes('D1');

    let text = `⚙️ <b>CÀI ĐẶT CẢNH BÁO NWE & SMC (DEMAND/SUPPLY - ORDER BLOCK)</b>\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `<i>Hệ thống tự động quét và gửi cảnh báo tức thì khi giá chạm dải Nadaraya-Watson Envelope (h=8, mult=3) hoặc chạm vùng Order Block (Cung/Cầu) trên các khung thời gian bạn kích hoạt:</i>\n\n`;

    text += `🔔 <b>Trạng thái các loại cảnh báo:</b>\n`;
    text += `• 🌊 Nadaraya-Watson Envelope (NWE): ${isNweOn ? '🟢 ĐANG BẬT' : '⚪ ĐANG TẮT'}\n`;
    text += `• 🧱 Order Block (Demand/Supply - Cung/Cầu): ${isSmcOn ? '🟢 ĐANG BẬT' : '⚪ ĐANG TẮT'}\n`;
    text += `• 🔥 Quét Thanh Khoản (Tier 2 VIP): ${isTier2On ? '🟢 ĐANG BẬT (Ưu tiên cao nhất)' : '⚪ ĐÃ TẮT'}\n\n`;

    text += `⏳ <b>Các khung thời gian đang kích hoạt (${tfs.length}/6 khung):</b>\n`;
    text += `• M5 (5 Phút): ${isM5 ? '🟢 Bật' : '⚪ Tắt'}\n`;
    text += `• M15 (15 Phút): ${isM15 ? '🟢 Bật' : '⚪ Tắt'}\n`;
    text += `• M30 (30 Phút): ${isM30 ? '🟢 Bật' : '⚪ Tắt'}\n`;
    text += `• H1 (1 Giờ): ${isH1 ? '🟢 Bật' : '⚪ Tắt'}\n`;
    text += `• H4 (4 Giờ): ${isH4 ? '🟢 Bật' : '⚪ Tắt'}\n`;
    text += `• D1 (1 Ngày): ${isD1 ? '🟢 Bật' : '⚪ Tắt'}\n\n`;

    text += `💡 <i>Bấm vào các nút bên dưới để Bật/Tắt loại cảnh báo hoặc từng khung thời gian:</i>`;

    const keyboard = Markup.inlineKeyboard([
      // Hàng 1: Nút Bật/Tắt 3 loại cảnh báo
      [
        Markup.button.callback(
          isNweOn ? '🌊 NWE: ✅ BẬT' : '🌊 NWE: ❌ TẮT',
          'smc_toggle_nwe',
        ),
        Markup.button.callback(
          isSmcOn ? '🧱 OB: ✅ BẬT' : '🧱 OB: ❌ TẮT',
          'smc_toggle_ob',
        ),
        Markup.button.callback(
          isTier2On ? '🔥 Tier 2: ✅ BẬT' : '🔥 Tier 2: ❌ TẮT',
          'smc_toggle_tier2',
        ),
      ],
      // Hàng 2: Khung ngắn hạn
      [
        Markup.button.callback(`${isM5 ? '✅' : '❌'} M5 (5p)`, 'smc_toggle_tf:M5'),
        Markup.button.callback(`${isM15 ? '✅' : '❌'} M15 (15p)`, 'smc_toggle_tf:M15'),
        Markup.button.callback(`${isM30 ? '✅' : '❌'} M30`, 'smc_toggle_tf:M30'),
      ],
      // Hàng 3: Khung trung & dài hạn
      [
        Markup.button.callback(`${isH1 ? '✅' : '❌'} H1 (1h)`, 'smc_toggle_tf:H1'),
        Markup.button.callback(`${isH4 ? '✅' : '❌'} H4 (4h)`, 'smc_toggle_tf:H4'),
        Markup.button.callback(`${isD1 ? '✅' : '❌'} D1 (1d)`, 'smc_toggle_tf:D1'),
      ],
      // Hàng 4: Thiết lập nhanh khung thời gian
      [
        Markup.button.callback('🔔 Bật tất cả 6 khung', 'smc_set_all_tf'),
        Markup.button.callback('🎯 Khuyên dùng (M5-H4)', 'smc_set_default_tf'),
      ],
      // Hàng 5: Xem nhanh phân tích
      [
        Markup.button.callback('📊 Xem NWE & SMC M15', 'smc_view:M15'),
        Markup.button.callback('📊 Xem M5', 'smc_view:M5'),
        Markup.button.callback('📊 Xem H1', 'smc_view:H1'),
      ],
    ]);

    return { text, keyboard };
  }

  /**
   * Tạo nội dung HTML và inline keyboard cho danh sách các cảnh báo giá đang chờ của User
   */
  private async renderPriceAlertsView(chatId: string): Promise<{ text: string; keyboard: any }> {
    const activeAlerts = await this.alertService.getUserActiveAlerts(chatId);

    if (activeAlerts.length === 0) {
      const text = `
📭 <b>BẠN CHƯA CÓ CẢNH BÁO GIÁ NÀO ĐANG HOẠT ĐỘNG</b>

💡 <b>Cách đặt cảnh báo giá tức thì:</b>
• 🟡 <b>Vàng:</b> <code>/alert xau 4200</code>
• 💎 <b>Crypto:</b> <code>/alert btc 83000</code> | <code>/alert eth 3500</code> | <code>/alert sol 220</code>

<i>👉 Bot sẽ quét liên tục mỗi vài giây và thông báo ngay khi giá chạm hoặc vượt ngưỡng kỳ vọng!</i>
      `.trim();

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Hướng dẫn đặt cảnh báo', 'alert_new')],
      ]);

      return { text, keyboard };
    }

    let text = `🔔 <b>DANH SÁCH CẢNH BÁO GIÁ ĐANG CHỜ (${activeAlerts.length})</b>\n\n`;

    const deleteButtons: any[] = [];

    activeAlerts.forEach((item, index) => {
      const alert = item.alert;
      const condIcon = alert.condition === 'ABOVE' ? '🚀 ≥' : '🔻 ≤';
      const assetIcon = alert.assetType === 'GOLD' ? '🟡' : '💎';

      text += `<b>${index + 1}. ${assetIcon} ${alert.displaySymbol}</b> <code>(#${alert.id})</code>\n`;
      text += `• 🎯 <b>Giá đặt cảnh báo:</b> <code>${item.formattedTargetPrice}</code> (${condIcon})\n`;
      text += `• 💵 <b>Giá thị trường hiện tại:</b> <code>${item.formattedCurrentPrice}</code>\n`;
      text += `• 📊 <b>Biến động:</b> <b>${item.distanceText}</b> <i>(lúc đặt: ${item.formattedInitialPrice})</i>\n\n`;

      deleteButtons.push(
        Markup.button.callback(`🗑 Hủy #${alert.id} (${alert.symbol}) - ${item.formattedTargetPrice}`, `alert_del:${alert.id}`)
      );
    });

    text += `<i>💡 Bấm vào nút bên dưới để hủy cảnh báo tương ứng:</i>`;

    // Sắp xếp các nút hủy thành các hàng (mỗi hàng 1 nút hoặc 2 nút tuỳ độ dài text)
    const buttonRows: any[][] = [];
    for (let i = 0; i < deleteButtons.length; i++) {
      buttonRows.push([deleteButtons[i]]);
    }

    // Hàng nút điều khiển chung
    buttonRows.push([
      Markup.button.callback('🔄 Làm mới giá', 'alert_refresh'),
      Markup.button.callback('🗑 Hủy tất cả', 'alert_clear'),
    ]);
    buttonRows.push([
      Markup.button.callback('➕ Đặt thêm cảnh báo', 'alert_new'),
    ]);

    const keyboard = Markup.inlineKeyboard(buttonRows);

    return { text, keyboard };
  }

  /**
   * Tạo giao diện Dashboard chiến lược BB(20)  /**
   * Tạo giao diện Dashboard chiến lược BB(20) + ATR(14)
   */
  private async renderBbAtrDashboardView(
    chatId: string,
    symbol = 'XAU',
    timeframe = 'M5',
  ): Promise<{ text: string; keyboard: any }> {
    const tf = this.bbAtrService.normalizeTimeframe(timeframe);
    const state = await this.bbAtrService.getBbAtrState(symbol, tf);
    const isAlertEnabled = await this.bbAtrService.getUserBbAtrEnabled(chatId);
    const bias = await this.bbAtrService.getUserBias(chatId);
    const isTier2Enabled = await this.bbAtrService.getUserTier2Enabled(chatId);

    const text = this.bbAtrService.renderDashboardMessage(state, isAlertEnabled, bias, isTier2Enabled);

    const isGold = state.assetType === 'GOLD';
    const alertToggleBtnText = isAlertEnabled
      ? '🔕 Tắt Cảnh Báo XAU M5'
      : '🔔 Bật Cảnh Báo XAU M5';

    // 3 nút bấm chọn bộ lọc xu hướng Bias trực quan
    const buyBtnText = bias === 'BUY_ONLY' ? '✅ 🟢 Chỉ Buy' : '🟢 Chỉ Buy';
    const sellBtnText = bias === 'SELL_ONLY' ? '✅ 🔴 Chỉ Sell' : '🔴 Chỉ Sell';
    const bothBtnText = bias === 'BOTH' ? '✅ ⚖️ Cả 2 chiều' : '⚖️ Cả 2 chiều';

    const m5Btn = tf === 'M5' ? '✅ 🟡 M5' : '🟡 M5';
    const m15Btn = tf === 'M15' ? '✅ 🟡 M15' : '🟡 M15';
    const h1Btn = tf === 'H1' ? '✅ 🟡 H1' : '🟡 H1';
    const h4Btn = tf === 'H4' ? '✅ 🟡 H4' : '🟡 H4';

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Làm Mới Dữ Liệu', `bbatr_view:${state.symbol}:${tf}`),
        ...(isGold ? [Markup.button.callback(alertToggleBtnText, 'bbatr_toggle')] : []),
      ],
      [
        Markup.button.callback(buyBtnText, 'bbatr_bias:BUY_ONLY'),
        Markup.button.callback(sellBtnText, 'bbatr_bias:SELL_ONLY'),
        Markup.button.callback(bothBtnText, 'bbatr_bias:BOTH'),
      ],
      [
        Markup.button.callback(m5Btn, 'bbatr_view:XAU:M5'),
        Markup.button.callback(m15Btn, 'bbatr_view:XAU:M15'),
        Markup.button.callback(h1Btn, 'bbatr_view:XAU:H1'),
        Markup.button.callback(h4Btn, 'bbatr_view:XAU:H4'),
      ],
      [
        Markup.button.callback(
          isTier2Enabled ? '🔥 Tier 3 (Rút Râu M5): ✅ BẬT' : '🔥 Tier 3 (Rút Râu M5): ❌ TẮT',
          'bbatr_toggle_tier2',
        ),
        Markup.button.callback('ℹ️ Hướng Dẫn', 'bbatr_help'),
      ],
    ]);

    return { text, keyboard };
  }

  /**
   * Tạo giao diện danh sách các cảnh báo cá nhân BB+ATR
   */
  private async renderBbAtrAlertsView(chatId: string): Promise<{ text: string; keyboard: any }> {
    const alerts = await this.bbAtrService.getUserActiveAlerts(chatId);
    const isGlobalEnabled = await this.bbAtrService.getUserBbAtrEnabled(chatId);

    let text = `📋 <b>DANH SÁCH CẢNH BÁO CHIẾN LƯỢC BB + ATR</b>\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `🔔 <b>Cảnh báo tự động XAU/USD M5:</b> <b>${isGlobalEnabled ? '🟢 ĐANG BẬT' : '⚪ ĐÃ TẮT'}</b>\n\n`;

    const buttons: any[] = [];

    if (alerts.length === 0) {
      text += `<i>Bạn chưa có cảnh báo cá nhân tùy biến nào.</i>\n`;
      text += `💡 <i>Bot vẫn tự động quét và báo XAU/USD M5 cho bạn nếu cảnh báo tự động đang BẬT!</i>\n\n`;
      text += `👉 Dùng lệnh <code>/bbatr alert [MÃ]</code> để tạo thêm cảnh báo cho BTC, ETH...`;
    } else {
      text += `🎯 <b>Các cảnh báo cá nhân đang theo dõi (${alerts.length}):</b>\n\n`;
      alerts.forEach((item, index) => {
        const { alert, statusText } = item;
        text += `<b>${index + 1}. #${alert.id} - ${alert.displaySymbol} [${alert.timeframe}]</b>\n`;
        text += `   • Trạng thái: <code>${statusText}</code>\n`;
        text += `   • Cặp chỉ báo: BB(20) & ATR(14)\n\n`;

        buttons.push([
          Markup.button.callback(`🗑 Hủy #${alert.id} (${alert.symbol} ${alert.timeframe})`, `bbatr_del:${alert.id}`),
        ]);
      });

      buttons.push([Markup.button.callback('🗑 Xóa Tất Cả Cảnh Báo Cá Nhân', 'bbatr_clear')]);
    }

    buttons.push([
      Markup.button.callback('📊 Bảng BB+ATR M5', 'bbatr_menu'),
      Markup.button.callback(isGlobalEnabled ? '🔕 Tắt Alert XAU M5' : '🔔 Bật Alert XAU M5', 'bbatr_toggle'),
    ]);

    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  /**
   * Hướng dẫn chi tiết chiến lược Bollinger Bands (20) + ATR (14) M5
   */
  private renderBbAtrHelpText(): string {
    return `
🎯 <b>HƯỚNG DẪN CHIẾN LƯỢC: BOLLINGER BANDS (20) + ATR (14) M5</b> 📈

<b>1. Ý TƯỞNG CỐT LÕI CỦA PHƯƠNG PHÁP:</b>
• <b>Bollinger Bands (20, 2):</b> Đo độ biến động chuẩn (Standard Deviation) và xác định dải biên độ giá thông thường (95% nến nằm trong dải).
• <b>ATR (14) - Average True Range:</b> Đo biên độ nến trung bình thực tế của 14 nến M5 gần nhất.
• Khi giá vượt ra ngoài Bollinger Bands một khoảng bằng đúng <b>1 cây nến ATR(14)</b>, tức là lực đẩy đã dãn hết cỡ (Extreme Overextended Exhaustion), khả năng kiệt sức và đảo chiều quay lại dải là cực kỳ cao!

<b>2. CÔNG THỨC VÀO LỆNH (ENTRY) & CẮT LỖ (SL = 1 ATR):</b>
🔴 <b>VÙNG BÁN (SELL ENTRY / SHORT):</b>
• <b>Entry:</b> <code>Upper Entry = Bands(20) Upper + ATR(14)</code>
• <b>Điểm Cắt Lỗ (SL):</b> <code>SL = Upper Entry + ATR(14)</code> (Đặt trên Entry đúng 1 ATR)
• <b>Hành động:</b> Khi giá chạm hoặc vượt ngưỡng này trên nến M5, canh mở vị thế BÁN (Short) hoặc chốt lời lệnh Mua.

🟢 <b>VÙNG MUA (BUY ENTRY / LONG):</b>
• <b>Entry:</b> <code>Lower Entry = Bands(20) Lower - ATR(14)</code>
• <b>Điểm Cắt Lỗ (SL):</b> <code>SL = Lower Entry - ATR(14)</code> (Đặt dưới Entry đúng 1 ATR)
• <b>Hành động:</b> Khi giá chạm hoặc đâm thủng ngưỡng này trên nến M5, canh mở vị thế MUA (Long) bắt đáy hồi phục.

<b>3. HỆ THỐNG PHÂN CẤP CẢNH BÁO (TIER SYSTEM):</b>
• 🔔 <b>TIER 0 (Chạm Dải BB):</b> Giá nến M5 chạm dải <code>Bands(20) Upper</code> hoặc <code>Bands(20) Lower</code> -> Cảnh báo theo dõi thông thường.
• 🔥 <b>TIER 1 (1 Đốm Lửa):</b> Khớp công thức Entry mở rộng <code>Bands(20) Upper + ATR(14)</code> hoặc <code>Bands(20) Lower - ATR(14)</code>.
• 🔥🔥 <b>TIER 2 (2 Đốm Lửa — Thỏa 1 trong 2 điều kiện):</b>
   - <b>Tier 2A (BB ± ATR + RSI cực trị):</b> <code>BB Upper + ATR</code> + <code>RSI(14) ≥ 70</code> (SELL) hoặc <code>BB Lower - ATR</code> + <code>RSI(14) ≤ 30</code> (BUY).
   - <b>Tier 2B (Nến rút râu từ chối tại dải BB):</b> Nến M5 đâm xuyên <code>BB Upper</code> / <code>BB Lower</code> và đóng thụt vào trong với râu từ chối mạnh (Pinbar hoặc nến đảo chiều thuận màu), không bắt buộc phải chạm <code>BB ± ATR</code>.
• 🔥🔥🔥 <b>TIER 3 (3 Đốm Lửa - VIP):</b> Khớp vùng <code>BB ± ATR</code> CỘNG VỚI <b>Nến rút râu từ chối M5</b> ngay tại mốc <code>BB Upper + ATR</code> (SELL) hoặc <code>BB Lower - ATR</code> (BUY)!

<b>4. BỘ LỌC XU HƯỚNG CHÍNH TRONG NGÀY (DAILY TREND BIAS):</b>
• 🟢 <b>BUY ONLY:</b> Khi xu hướng ngày là Tăng mạnh, chỉ nhận cảnh báo khi giá chạm Lower Entry để BUY (bỏ qua Upper Entry).
• 🔴 <b>SELL ONLY:</b> Khi xu hướng ngày là Giảm mạnh, chỉ nhận cảnh báo khi giá chạm Upper Entry để SELL (bỏ qua Lower Entry).
• ⚖️ <b>BOTH (Mặc định):</b> Nhận cảnh báo cả 2 chiều BUY & SELL khi có tín hiệu.

<b>5. CÚ PHÁP LỆNH:</b>
• <code>/bbatr</code> (hoặc <code>/bb</code>) - Mở Bảng đo kỹ thuật XAU/USD M5
• <code>/bbatr bias buy</code> (hoặc <code>/bbatr buy</code>) - Lọc chỉ canh BUY
• <code>/bbatr bias sell</code> (hoặc <code>/bbatr sell</code>) - Lọc chỉ canh SELL
• <code>/bbatr bias both</code> (hoặc <code>/bbatr both</code>) - Bật cảnh báo cả 2 chiều
• <code>/bbatr on</code> / <code>/bbatr off</code> - Bật/Tắt nhận cảnh báo tự động XAU/USD M5
• <code>/bbatr btc</code> - Xem bảng đo cho Bitcoin khung M5
• <code>/bbatr eth 15m</code> - Xem bảng đo cho ETH khung 15m
• <code>/bbatr alert btc</code> - Đặt cảnh báo cá nhân cho BTC M5
• <code>/bbatr list</code> - Xem danh sách cảnh báo cá nhân
• <code>/bbatr del ID</code> - Hủy 1 cảnh báo cá nhân
    `.trim();
  }
}

