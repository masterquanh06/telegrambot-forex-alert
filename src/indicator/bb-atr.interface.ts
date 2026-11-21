import { EmaTimeframe } from './indicator.interface';

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BollingerBandsResult {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
  percentB: number;
}

export type BbAtrSignalType =
  | 'NORMAL'
  | 'TOUCH_UPPER_BB'
  | 'ENTRY_SELL'
  | 'TOUCH_LOWER_BB'
  | 'ENTRY_BUY'
  | 'BUY_CONFLUENCE'
  | 'SELL_CONFLUENCE'
  | 'BUY'
  | 'SELL';

export type BbAtrBias = 'BOTH' | 'BUY_ONLY' | 'SELL_ONLY';

export interface BbAtrState {
  symbol: string;
  displaySymbol: string;
  assetType: 'GOLD' | 'CRYPTO';
  timeframe: EmaTimeframe; // Khung nến (Mặc định M5)
  candleTime?: number; // Thời điểm mở nến (timestamp ms)
  consecutiveTouches?: number; // Số nến liên tiếp chạm dải
  currentPrice: number;
  candleHigh: number;
  candleLow: number;

  // Bollinger Bands (20, 2)
  bbPeriod: number;
  bbStdDev: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;

  // ATR (14)
  atrPeriod: number;
  atrValue: number;

  // RSI (14) - Bộ lọc hợp lưu điểm vào lệnh
  rsiPeriod?: number;
  rsiValue?: number;
  isRsiOversold?: boolean; // RSI <= 30
  isRsiOverbought?: boolean; // RSI >= 70

  // Ngưỡng Entry của Chiến lược:
  // Upper Entry = BB Upper + ATR
  // Lower Entry = BB Lower - ATR
  upperEntry: number;
  lowerEntry: number;

  // Điểm Cắt Lỗ (Stop Loss) bằng đúng 1 ATR:
  // Sell SL = Upper Entry + ATR
  // Buy SL = Lower Entry - ATR
  sellSl: number;
  buySl: number;
  slDistance: number;

  // Khoảng cách từ giá hiện tại đến các ngưỡng
  distToUpper: number;
  distToUpperPercent: number;
  distToLower: number;
  distToLowerPercent: number;

  // Trạng thái tín hiệu
  signal: BbAtrSignalType;
  signalReason: string;
  updatedAt: Date;
}

export interface BbAtrAlertItem {
  id: number;
  chatId: string;
  username?: string | null;
  symbol: string;
  displaySymbol: string;
  assetType: string;
  timeframe: string;
  bbPeriod: number;
  bbStdDev: number;
  atrPeriod: number;
  bias?: BbAtrBias | string;
  lastSignal?: string | null;
  lastSignalPrice?: number | null;
  lastTriggeredAt?: Date | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBbAtrAlertDto {
  chatId: string;
  username?: string;
  symbol: string;
  timeframe?: EmaTimeframe;
  bbPeriod?: number;
  bbStdDev?: number;
  atrPeriod?: number;
  bias?: BbAtrBias;
}

export interface CreateBbAtrAlertResult {
  success: boolean;
  message: string;
  alert?: BbAtrAlertItem;
  state?: BbAtrState;
}

export interface ActiveBbAtrAlertDetail {
  alert: BbAtrAlertItem;
  state?: BbAtrState;
  statusText: string;
}
