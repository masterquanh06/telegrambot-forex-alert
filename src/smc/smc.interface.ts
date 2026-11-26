import { SweepSignal } from '../services/liquiditySweep';
import type { SmcMtfTierReason } from './smc-mtf-classifier';

export type SmcTimeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1';

export interface NweEnvelope {
  kernel: number;            // Đường hồi quy trung tâm (Nadaraya-Watson Kernel)
  upperBand: number;         // Dải biên trên (Upper Envelope Band)
  lowerBand: number;         // Dải biên dưới (Lower Envelope Band)
  mae: number;               // Biên độ sai số tuyệt đối trung bình (Mean Absolute Error)
  dynamicResistance: number; // Ngưỡng kháng cự động (Dynamic Resistance)
  dynamicSupport: number;    // Ngưỡng hỗ trợ động (Dynamic Support)
  isTouchUpper: boolean;     // Giá chạm/vượt dải trên
  isTouchLower: boolean;     // Giá chạm/thủng dải dưới
}

export interface OrderBlock {
  id: string;
  index: number;
  time: number;
  top: number;              // Mức giá đỉnh của vùng (Upper edge)
  bottom: number;           // Mức giá đáy của vùng (Lower edge)
  type: 'DEMAND' | 'SUPPLY';
  label: string;            // Ví dụ: "Vùng Cầu M15 (Bullish OB)", "Vùng Cung H1 (Bearish OB)"
  timeframe: SmcTimeframe;
  mitigated: boolean;       // Đã bị xuyên thủng chưa
}

export interface KeyLevel {
  price: number;
  type: 'PIVOT_HIGH' | 'PIVOT_LOW' | 'HIGHEST' | 'LOWEST';
  label: string;
  timeframe: SmcTimeframe;
}

export type SmcSignalType =
  | 'NORMAL'
  | 'TOUCH_NWE_UPPER'
  | 'TOUCH_NWE_LOWER'
  | 'TOUCH_SUPPLY_OB'
  | 'TOUCH_DEMAND_OB'
  | 'CONFLUENCE_SELL'
  | 'CONFLUENCE_BUY';

export interface SmcAnalysisResult {
  symbol: string;
  displaySymbol: string;
  currentPrice: number;
  timeframe: SmcTimeframe;
  nwe: NweEnvelope;
  activeDemand: OrderBlock[];
  activeSupply: OrderBlock[];
  keyLevels: KeyLevel[];
  touchingDemand: OrderBlock | null;
  touchingSupply: OrderBlock | null;
  signal: SmcSignalType;
  signalReason: string;
  sweepSignal?: SweepSignal;
  alertTier?: 1 | 2 | 3;
  updatedAt: Date;
}

export interface SmcMtfAlertPayload {
  symbol: string;
  displaySymbol: string;
  currentPrice: number;
  nweH1: NweEnvelope;
  matchedOrderBlocks: OrderBlock[];
  primaryOb: OrderBlock;
  confluenceLevel: number;
  atrM15: number;
  signal: 'CONFLUENCE_SELL' | 'CONFLUENCE_BUY';
  direction: 'SELL' | 'BUY';
  alertTier: 2 | 3;
  tierReason: SmcMtfTierReason;
  signalReason: string;
  rejectionCandleTime?: number;
  updatedAt: Date;
}

export interface UserSmcSettings {
  nweAlertEnabled: boolean;   // Bật/tắt cảnh báo Nadaraya-Watson Envelope
  nweTimeframes: SmcTimeframe[]; // Khung thời gian bật theo dõi NWE
  smcAlertEnabled: boolean;   // Bật/tắt cảnh báo Supply/Demand & Order Block
  smcTimeframes: SmcTimeframe[]; // Khung thời gian bật theo dõi Order Block
  timeframes: SmcTimeframe[]; // Khung thời gian fallback chung
  tier1AlertEnabled?: boolean;   // Bật/tắt cảnh báo Tier 1 (đơn khung)
  tier2SignalEnabled?: boolean;  // Bật/tắt cảnh báo Tier 2 (hợp lưu MTF)
  tier3AlertEnabled?: boolean;   // Bật/tắt cảnh báo Tier 3 VIP
  tier2AlertEnabled?: boolean;   // Cột cũ tương thích ngược cho Tier 3 VIP
}
