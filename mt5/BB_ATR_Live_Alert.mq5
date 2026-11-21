//+------------------------------------------------------------------+
//|                                           BB_ATR_Live_Alert.mq5  |
//|               Expert Advisor bắn Webhook tức thì về Telegram Bot |
//|                                     Khung thời gian: M5 (5 Phút) |
//|   Chiến lược: Bollinger Bands(20) + ATR(14) + Bộ lọc RSI(14)    |
//+------------------------------------------------------------------+
#property copyright "Financial Alert Bot"
#property link      "https://t.me"
#property version   "1.10"
#property strict

//--- Inputs
input string   InpWebhookUrl      = "http://localhost:3001/api/webhook/bbatr"; // Webhook URL Bot
input int      InpBBPeriod        = 20;            // Bollinger Bands Period
input double   InpBBDeviation     = 2.0;           // Bollinger Bands Deviation
input int      InpATRPeriod       = 14;            // ATR Period
input int      InpRsiPeriod       = 14;            // RSI Period
input double   InpRsiOversold     = 30.0;          // RSI Quá Bán (Buy Confluence)
input double   InpRsiOverbought   = 70.0;          // RSI Quá Mua (Sell Confluence)

//--- Handles
int hBB = INVALID_HANDLE;
int hATR = INVALID_HANDLE;
int hRSI = INVALID_HANDLE;
datetime lastAlertBar = 0;
string lastSignalType = "";

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   hBB = iBands(_Symbol, _Period, InpBBPeriod, 0, InpBBDeviation, PRICE_CLOSE);
   hATR = iATR(_Symbol, _Period, InpATRPeriod);
   hRSI = iRSI(_Symbol, _Period, InpRsiPeriod, PRICE_CLOSE);

   if(hBB == INVALID_HANDLE || hATR == INVALID_HANDLE || hRSI == INVALID_HANDLE)
   {
      Print("❌ Lỗi tạo indicator handles!");
      return(INIT_FAILED);
   }

   Print("✅ BB_ATR_Live_Alert EA đã khởi chạy thành công trên ", _Symbol, " [", EnumToString(_Period), "]");
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
}

//+------------------------------------------------------------------+
//| Gửi HTTP POST Webhook về Backend Bot                             |
//+------------------------------------------------------------------+
void SendWebhookAlert(string signal, double price, double upper, double lower, double middle, double atr, double rsi)
{
   string headers = "Content-Type: application/json\r\n";
   char postData[];
   char result[];
   string resultHeaders;

   string json = StringFormat(
      "{\"symbol\":\"%s\",\"timeframe\":\"%s\",\"broker\":\"%s\",\"price\":%.2f,\"signal\":\"%s\",\"bbUpper\":%.2f,\"bbLower\":%.2f,\"bbMiddle\":%.2f,\"atr\":%.2f,\"rsi\":%.2f}",
      _Symbol,
      EnumToString(_Period),
      AccountInfoString(ACCOUNT_COMPANY),
      price,
      signal,
      upper,
      lower,
      middle,
      atr,
      rsi
   );

   StringToCharArray(json, postData, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(postData, ArraySize(postData) - 1); // Bỏ ký tự null cuối

   int res = WebRequest("POST", InpWebhookUrl, headers, 3000, postData, result, resultHeaders);
   if(res == 200 || res == 201)
   {
      Print("🔔 Đã bắn Webhook thành công: ", signal, " tại giá ", price, " | RSI: ", rsi);
   }
   else
   {
      Print("⚠️ Lỗi gửi WebRequest (code: ", res, ", err: ", GetLastError(), "). Nhớ thêm URL vào Tools -> Options -> Expert Advisors -> Allow WebRequest!");
   }
}

//+------------------------------------------------------------------+
//| Expert tick function (Chạy tức thì trên từng tick giá)           |
//+------------------------------------------------------------------+
void OnTick()
{
   double bbUpper[1], bbLower[1], bbMiddle[1], atrVal[1], rsiVal[1];
   if(CopyBuffer(hBB, 1, 0, 1, bbUpper) <= 0) return;
   if(CopyBuffer(hBB, 2, 0, 1, bbLower) <= 0) return;
   if(CopyBuffer(hBB, 0, 0, 1, bbMiddle) <= 0) return;
   if(CopyBuffer(hATR, 0, 0, 1, atrVal) <= 0) return;
   if(CopyBuffer(hRSI, 0, 0, 1, rsiVal) <= 0) return;

   double upper = bbUpper[0];
   double lower = bbLower[0];
   double middle = bbMiddle[0];
   double atr = atrVal[0];
   double rsi = rsiVal[0];

   double upperEntry = upper + atr;
   double lowerEntry = lower - atr;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double currentPrice = (ask + bid) / 2.0;

   datetime currentBar = iTime(_Symbol, _Period, 0);

   string signal = "NORMAL";

   // 1. Phía UPPER (Sell):
   // - Khớp công thức Entry gốc: Giá chạm/vượt Bands Upper + ATR(14)
   if(currentPrice >= upperEntry)
      signal = "ENTRY_SELL";
   // - Hợp lưu tiêu chuẩn: Chạm BB Upper VÀ RSI >= 70
   else if(currentPrice >= upper && rsi >= InpRsiOverbought)
      signal = "SELL_CONFLUENCE";
   // 2. Phía LOWER (Buy):
   // - Khớp công thức Entry gốc: Giá đâm thủng Bands Lower - ATR(14)
   else if(currentPrice <= lowerEntry)
      signal = "ENTRY_BUY";
   // - Hợp lưu tiêu chuẩn: Chạm BB Lower VÀ RSI <= 30
   else if(currentPrice <= lower && rsi <= InpRsiOversold)
      signal = "BUY_CONFLUENCE";

   if(signal == "NORMAL")
   {
      lastSignalType = "NORMAL";
      return;
   }

   bool isNewBar = (currentBar > lastAlertBar);
   bool isUpgrade = (lastSignalType == "BUY_CONFLUENCE" && signal == "ENTRY_BUY") ||
                    (lastSignalType == "SELL_CONFLUENCE" && signal == "ENTRY_SELL");

   if(isNewBar || isUpgrade)
   {
      lastAlertBar = currentBar;
      lastSignalType = signal;
      SendWebhookAlert(signal, currentPrice, upper, lower, middle, atr, rsi);
   }
}
