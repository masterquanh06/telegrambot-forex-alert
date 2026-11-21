//+------------------------------------------------------------------+
//|                                          BB_ATR_AutoTrader.mq5   |
//|               Expert Advisor (EA) Tự Động Giao Dịch Trên MT5     |
//|  Chiến lược: Bollinger Bands(20) + ATR(14) + Bộ Lọc RSI(14)      |
//|  Khung thời gian khuyến nghị: M5 (5 Phút) - XAU/USD (Vàng Forex) |
//+------------------------------------------------------------------+
#property copyright   "Financial Alert Bot & Trading System"
#property link        "https://t.me"
#property version     "2.00"
#property description "EA tự động vào lệnh Buy/Sell theo chiến lược Bollinger Bands(20) + ATR(14) + RSI(14)"

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\AccountInfo.mqh>

//--- ENUMS
enum ENUM_ENTRY_MODE
{
   MODE_CONFLUENCE = 0, // 🎯 Chạm BB + RSI cực trị (≤30 Buy / ≥70 Sell)
   MODE_EXTREME    = 1, // 🚨 Vùng cực hạn BB +/- 1 ATR (Upper + ATR / Lower - ATR)
   MODE_BOTH       = 2  // ⚡ Cả 2 điều kiện (Khớp điều kiện nào vào lệnh đó)
};

enum ENUM_LOT_TYPE
{
   LOT_FIXED = 0,       // Khối lượng Lot cố định
   LOT_RISK_PERCENT = 1 // Tự động tính Lot theo % Rủi ro tài khoản
};

enum ENUM_TP_MODE
{
   TP_RR_RATIO    = 0,  // Tỷ lệ R:R cố định (Mặc định 1:2)
   TP_BB_MIDDLE   = 1,  // Chốt lời tại trục giữa Bands(20) Middle
   TP_OPPOSITE_BB = 2   // Chốt lời tại dải đối diện (Bands ngược chiều)
};

enum ENUM_BIAS_MODE
{
   BIAS_BOTH      = 0,  // ⚖️ Cả 2 chiều (Buy & Sell)
   BIAS_BUY_ONLY  = 1,  // 🟢 Chỉ MUA (Bỏ qua tín hiệu Bán)
   BIAS_SELL_ONLY = 2   // 🔴 Chỉ BÁN (Bỏ qua tín hiệu Mua)
};

//+------------------------------------------------------------------+
//| INPUT PARAMETERS                                                 |
//+------------------------------------------------------------------+
input group "=== 1. CẤU HÌNH CHIẾN LƯỢC ==="
input ENUM_ENTRY_MODE   InpEntryMode        = MODE_BOTH;         // Chế độ vào lệnh
input ENUM_BIAS_MODE    InpBiasMode         = BIAS_BOTH;         // Lọc xu hướng chính (Bias)
input int               InpBBPeriod         = 20;                // Chu kỳ Bollinger Bands
input double            InpBBDeviation      = 2.0;               // Độ lệch Bollinger Bands
input int               InpATRPeriod        = 14;                // Chu kỳ ATR
input int               InpRSIPeriod        = 14;                // Chu kỳ RSI
input double            InpRSIOversold      = 30.0;              // Ngưỡng RSI Quá Bán (Buy)
input double            InpRSIOverbought    = 70.0;              // Ngưỡng RSI Quá Mua (Sell)

input group "=== 2. QUẢN LÝ VỐN & ĐI KIỆN VÀO LỆNH ==="
input ENUM_LOT_TYPE     InpLotType          = LOT_FIXED;         // Loại quản lý khối lượng
input double            InpFixedLot         = 0.01;              // Khối lượng Lot cố định
input double            InpRiskPercent      = 1.0;               // % Rủi ro mỗi lệnh (% Balance)
input int               InpMaxPositions     = 1;                 // Số lệnh mở tối đa cùng lúc
input double            InpMaxSpreadPoints  = 35.0;              // Spread tối đa cho phép (Points)

input group "=== 3. CẮT LỖ (SL) & CHỐT LỜI (TP) ==="
input double            InpSlAtrMultiplier  = 1.0;               // Cắt Lỗ (SL) = Số lần ATR (Mặc định: 1 ATR)
input ENUM_TP_MODE      InpTpMode           = TP_RR_RATIO;       // Chế độ Chốt Lời (TP)
input double            InpTpRrRatio        = 2.0;               // Tỷ lệ R:R (nếu chọn TP_RR_RATIO)
input bool              InpUseBreakEven     = true;              // Kích hoạt Dời SL về Hòa Vốn (Break-Even)
input double            InpBeTriggerAtr     = 0.8;               // Khi lãi đạt X lần ATR -> Dời SL về Entry

input group "=== 4. HỆ THỐNG & THÔNG BÁO ==="
input ulong             InpMagicNumber      = 888999;            // Magic Number định danh bot
input string            InpTradeComment     = "BB_ATR_Bot";      // Ghi chú lệnh
input bool              InpSendTelegramWeb  = false;             // Gửi Webhook về bot Telegram khi khớp lệnh
input string            InpWebhookUrl       = "http://localhost:3001/api/webhook/bbatr"; // Webhook URL Bot

//--- Global Objects & Handles
CTrade         m_trade;
CPositionInfo  m_position;
CAccountInfo   m_account;

int            hBB  = INVALID_HANDLE;
int            hATR = INVALID_HANDLE;
int            hRSI = INVALID_HANDLE;

datetime       lastTradeBar = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   // Cấu hình CTrade
   m_trade.SetExpertMagicNumber(InpMagicNumber);
   m_trade.SetMarginMode();
   m_trade.SetTypeFillingBySymbol(_Symbol);
   m_trade.SetDeviationInPoints(20);

   // Khởi tạo các Indicators
   hBB  = iBands(_Symbol, _Period, InpBBPeriod, 0, InpBBDeviation, PRICE_CLOSE);
   hATR = iATR(_Symbol, _Period, InpATRPeriod);
   hRSI = iRSI(_Symbol, _Period, InpRSIPeriod, PRICE_CLOSE);

   if(hBB == INVALID_HANDLE || hATR == INVALID_HANDLE || hRSI == INVALID_HANDLE)
   {
      Print("❌ [INIT ERROR] Không thể tạo handle cho các chỉ báo kỹ thuật!");
      return(INIT_FAILED);
   }

   PrintFormat("🚀 [BB_ATR_AutoTrader] Khởi chạy thành công trên %s [%s] | Magic: %d",
               _Symbol, EnumToString(_Period), InpMagicNumber);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   IndicatorRelease(hBB);
   IndicatorRelease(hATR);
   IndicatorRelease(hRSI);
   Print("🛑 [DEINIT] EA đã dừng hoạt động.");
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // 1. Kiểm tra Spread thị trường
   double spread = (double)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   if(InpMaxSpreadPoints > 0 && spread > InpMaxSpreadPoints)
   {
      return; // Giãn spread thì không mở lệnh
   }

   // 2. Quản lý dời SL về hòa vốn (Break-Even) cho các lệnh đang chạy
   if(InpUseBreakEven)
   {
      ManageBreakEven();
   }

   // 3. Đọc dữ liệu chỉ báo kỹ thuật tại nến hiện tại
   double bbUpper[2], bbLower[2], bbMiddle[2], atrVal[2], rsiVal[2];
   if(CopyBuffer(hBB, 1, 0, 2, bbUpper) <= 0) return;
   if(CopyBuffer(hBB, 2, 0, 2, bbLower) <= 0) return;
   if(CopyBuffer(hBB, 0, 0, 2, bbMiddle) <= 0) return;
   if(CopyBuffer(hATR, 0, 0, 2, atrVal) <= 0) return;
   if(CopyBuffer(hRSI, 0, 0, 2, rsiVal) <= 0) return;

   double upper     = bbUpper[0];
   double lower     = bbLower[0];
   double middle    = bbMiddle[0];
   double atr       = atrVal[0];
   double rsi       = rsiVal[0];

   double upperEntry = upper + atr; // Vùng Entry Sell cực hạn
   double lowerEntry = lower - atr; // Vùng Entry Buy cực hạn

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double currentPrice = (ask + bid) / 2.0;

   // 4. Kiểm tra nến mới: Chỉ mở tối đa 1 lệnh trên mỗi cây nến M5
   datetime currentBar = iTime(_Symbol, _Period, 0);
   if(currentBar == lastTradeBar)
   {
      return; // Đã vào lệnh ở cây nến này rồi
   }

   // 5. Kiểm tra số lượng vị thế đang mở
   if(CountOpenPositions() >= InpMaxPositions)
   {
      return;
   }

   // 6. XÉT TÍN HIỆU VÀO LỆNH
   bool buySignal  = false;
   bool sellSignal = false;
   string reason   = "";

   // --- PHÍA BUY (MUA) ---
   if(InpBiasMode != BIAS_SELL_ONLY)
   {
      // Điều kiện A: Chạm dải dưới BB VÀ RSI <= 30
      bool isConfluenceBuy = (currentPrice <= lower && rsi <= InpRSIOversold);

      // Điều kiện B: Đâm thủng dải dưới thêm 1 ATR (Lower - ATR)
      bool isExtremeBuy    = (currentPrice <= lowerEntry);

      if(InpEntryMode == MODE_CONFLUENCE && isConfluenceBuy)
      {
         buySignal = true;
         reason = "Hợp lưu Chạm BB Lower + RSI <= 30";
      }
      else if(InpEntryMode == MODE_EXTREME && isExtremeBuy)
      {
         buySignal = true;
         reason = "Khớp Vùng Cực Hạn (BB Lower - 1 ATR)";
      }
      else if(InpEntryMode == MODE_BOTH)
      {
         if(isExtremeBuy)
         {
            buySignal = true;
            reason = "Khớp Vùng Cực Hạn (BB Lower - 1 ATR)";
         }
         else if(isConfluenceBuy)
         {
            buySignal = true;
            reason = "Hợp lưu Chạm BB Lower + RSI <= 30";
         }
      }
   }

   // --- PHÍA SELL (BÁN) ---
   if(InpBiasMode != BIAS_BUY_ONLY)
   {
      // Điều kiện A: Chạm dải trên BB VÀ RSI >= 70
      bool isConfluenceSell = (currentPrice >= upper && rsi >= InpRSIOverbought);

      // Điều kiện B: Bung vượt dải trên thêm 1 ATR (Upper + ATR)
      bool isExtremeSell    = (currentPrice >= upperEntry);

      if(InpEntryMode == MODE_CONFLUENCE && isConfluenceSell)
      {
         sellSignal = true;
         reason = "Hợp lưu Chạm BB Upper + RSI >= 70";
      }
      else if(InpEntryMode == MODE_EXTREME && isExtremeSell)
      {
         sellSignal = true;
         reason = "Khớp Vùng Cực Hạn (BB Upper + 1 ATR)";
      }
      else if(InpEntryMode == MODE_BOTH)
      {
         if(isExtremeSell)
         {
            sellSignal = true;
            reason = "Khớp Vùng Cực Hạn (BB Upper + 1 ATR)";
         }
         else if(isConfluenceSell)
         {
            sellSignal = true;
            reason = "Hợp lưu Chạm BB Upper + RSI >= 70";
         }
      }
   }

   // 7. THỰC THI LỆNH
   if(buySignal)
   {
      ExecuteBuy(ask, atr, middle, upper, reason);
      lastTradeBar = currentBar;
   }
   else if(sellSignal)
   {
      ExecuteSell(bid, atr, middle, lower, reason);
      lastTradeBar = currentBar;
   }
}

//+------------------------------------------------------------------+
//| Thực thi lệnh BUY                                                |
//+------------------------------------------------------------------+
void ExecuteBuy(double price, double atr, double middle, double upper, string reason)
{
   double slDistance = atr * InpSlAtrMultiplier;
   double sl = NormalizePrice(price - slDistance);
   double tp = 0;

   if(InpTpMode == TP_RR_RATIO)
   {
      tp = NormalizePrice(price + (slDistance * InpTpRrRatio));
   }
   else if(InpTpMode == TP_BB_MIDDLE)
   {
      tp = NormalizePrice(middle);
   }
   else if(InpTpMode == TP_OPPOSITE_BB)
   {
      tp = NormalizePrice(upper);
   }

   double lotSize = CalculateLotSize(slDistance);

   if(m_trade.Buy(lotSize, _Symbol, price, sl, tp, InpTradeComment + " [BUY]"))
   {
      PrintFormat("🟢 [BUY EXECUTED] Lot: %.2f | Giá: %.2f | SL: %.2f (%.2f ATR) | TP: %.2f | Lý do: %s",
                  lotSize, price, sl, InpSlAtrMultiplier, tp, reason);

      if(InpSendTelegramWeb)
      {
         SendTelegramNotification("BUY", price, sl, tp, lotSize, reason);
      }
   }
   else
   {
      PrintFormat("❌ [BUY FAILED] Lỗi mở lệnh: %d - %s", m_trade.ResultRetcode(), m_trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
//| Thực thi lệnh SELL                                               |
//+------------------------------------------------------------------+
void ExecuteSell(double price, double atr, double middle, double lower, string reason)
{
   double slDistance = atr * InpSlAtrMultiplier;
   double sl = NormalizePrice(price + slDistance);
   double tp = 0;

   if(InpTpMode == TP_RR_RATIO)
   {
      tp = NormalizePrice(price - (slDistance * InpTpRrRatio));
   }
   else if(InpTpMode == TP_BB_MIDDLE)
   {
      tp = NormalizePrice(middle);
   }
   else if(InpTpMode == TP_OPPOSITE_BB)
   {
      tp = NormalizePrice(lower);
   }

   double lotSize = CalculateLotSize(slDistance);

   if(m_trade.Sell(lotSize, _Symbol, price, sl, tp, InpTradeComment + " [SELL]"))
   {
      PrintFormat("🔴 [SELL EXECUTED] Lot: %.2f | Giá: %.2f | SL: %.2f (%.2f ATR) | TP: %.2f | Lý do: %s",
                  lotSize, price, sl, InpSlAtrMultiplier, tp, reason);

      if(InpSendTelegramWeb)
      {
         SendTelegramNotification("SELL", price, sl, tp, lotSize, reason);
      }
   }
   else
   {
      PrintFormat("❌ [SELL FAILED] Lỗi mở lệnh: %d - %s", m_trade.ResultRetcode(), m_trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
//| Quản lý Dời SL về Hòa Vốn (Break-Even)                           |
//+------------------------------------------------------------------+
void ManageBreakEven()
{
   double atrVal[1];
   if(CopyBuffer(hATR, 0, 0, 1, atrVal) <= 0) return;
   double beDistance = atrVal[0] * InpBeTriggerAtr;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(m_position.SelectByIndex(i))
      {
         if(m_position.Symbol() == _Symbol && m_position.Magic() == InpMagicNumber)
         {
            double openPrice = m_position.PriceOpen();
            double currentSl = m_position.StopLoss();
            double curPrice  = m_position.PriceCurrent();
            ENUM_POSITION_TYPE type = m_position.PositionType();

            if(type == POSITION_TYPE_BUY)
            {
               // Giá đã chạy dương hơn mức BE Trigger và SL chưa nằm trên Entry
               if(curPrice - openPrice >= beDistance && (currentSl < openPrice || currentSl == 0))
               {
                  double newSl = NormalizePrice(openPrice + (2 * _Point * 10)); // Hòa vốn + chút phí
                  m_trade.PositionModify(m_position.Ticket(), newSl, m_position.TakeProfit());
                  PrintFormat("🛡 [BREAK-EVEN] Đã dời SL về hòa vốn cho lệnh BUY #%I64d tại %.2f",
                              m_position.Ticket(), newSl);
               }
            }
            else if(type == POSITION_TYPE_SELL)
            {
               if(openPrice - curPrice >= beDistance && (currentSl > openPrice || currentSl == 0))
               {
                  double newSl = NormalizePrice(openPrice - (2 * _Point * 10));
                  m_trade.PositionModify(m_position.Ticket(), newSl, m_position.TakeProfit());
                  PrintFormat("🛡 [BREAK-EVEN] Đã dời SL về hòa vốn cho lệnh SELL #%I64d tại %.2f",
                              m_position.Ticket(), newSl);
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Tính toán khối lượng Lot chuẩn xác theo Quản Lý Vốn              |
//+------------------------------------------------------------------+
double CalculateLotSize(double slDistancePrice)
{
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   if(InpLotType == LOT_FIXED)
   {
      return MathMax(minLot, MathMin(maxLot, InpFixedLot));
   }

   // Tính Lot theo % Rủi ro số dư tài khoản
   double balance     = m_account.Balance();
   double riskMoney   = balance * (InpRiskPercent / 100.0);
   double tickSize    = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue   = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);

   if(slDistancePrice <= 0 || tickSize <= 0 || tickValue <= 0)
   {
      return minLot;
   }

   double moneyPerLot = (slDistancePrice / tickSize) * tickValue;
   if(moneyPerLot <= 0) return minLot;

   double rawLot = riskMoney / moneyPerLot;
   double steps  = MathFloor(rawLot / lotStep);
   double finalLot = steps * lotStep;

   return MathMax(minLot, MathMin(maxLot, NormalizeDouble(finalLot, 2)));
}

//+------------------------------------------------------------------+
//| Đếm số lệnh đang mở bởi EA này                                   |
//+------------------------------------------------------------------+
int CountOpenPositions()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(m_position.SelectByIndex(i))
      {
         if(m_position.Symbol() == _Symbol && m_position.Magic() == InpMagicNumber)
         {
            count++;
         }
      }
   }
   return count;
}

//+------------------------------------------------------------------+
//| Chuẩn hóa mức giá theo Digits của sàn                            |
//+------------------------------------------------------------------+
double NormalizePrice(double price)
{
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   return NormalizeDouble(price, digits);
}

//+------------------------------------------------------------------+
//| Gửi Webhook thông báo về Telegram Bot khi khớp lệnh              |
//+------------------------------------------------------------------+
void SendTelegramNotification(string action, double price, double sl, double tp, double lot, string reason)
{
   string headers = "Content-Type: application/json\r\n";
   char postData[];
   char result[];
   string resultHeaders;

   string json = StringFormat(
      "{\"symbol\":\"%s\",\"action\":\"%s\",\"price\":%.2f,\"sl\":%.2f,\"tp\":%.2f,\"lot\":%.2f,\"reason\":\"%s\",\"broker\":\"%s\"}",
      _Symbol,
      action,
      price,
      sl,
      tp,
      lot,
      reason,
      AccountInfoString(ACCOUNT_COMPANY)
   );

   StringToCharArray(json, postData, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(postData, ArraySize(postData) - 1);

   WebRequest("POST", InpWebhookUrl, headers, 3000, postData, result, resultHeaders);
}
