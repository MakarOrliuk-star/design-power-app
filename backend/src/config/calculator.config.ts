// src/config/calculator.config.ts

export const CURRENCY_DATA: Record<string, { rate: number; currency_enum_id: number }> = {
  ADA: { rate: 1.83, currency_enum_id: 29131772 },
  ALL: { rate: 100, currency_enum_id: 32633008 },
  AUD: { rate: 1.5, currency_enum_id: 12544536 },
  BAM: { rate: 2, currency_enum_id: 33030710 },
  BGN: { rate: 2, currency_enum_id: 13083018 },
  BNB: { rate: 0.001077, currency_enum_id: 29132551 },
  BNBSC: { rate: 0.001077, currency_enum_id: 29131841 },
  BRL: { rate: 5, currency_enum_id: 26447838 },
  BTC: { rate: 0.000011, currency_enum_id: 19036369 },
  BUSD: { rate: 1, currency_enum_id: 29132554 },
  CAD: { rate: 1.5, currency_enum_id: 12141448 },
  CHF: { rate: 1, currency_enum_id: 13048181 },
  CLP: { rate: 1000, currency_enum_id: 26488769 },
  COP: { rate: 4000, currency_enum_id: 30614221 },
  CZK: { rate: 25, currency_enum_id: 13074289 },
  DKK: { rate: 10, currency_enum_id: 12708440 },
  DOGE: { rate: 4.8, currency_enum_id: 19360133 },
  ETH: { rate: 0.0003, currency_enum_id: 19360110 },
  EUR: { rate: 1, currency_enum_id: 12002524 },
  GBP: { rate: 1, currency_enum_id: 29439425 },
  HRK: { rate: 10, currency_enum_id: 12997872 },
  HUF: { rate: 400, currency_enum_id: 18385633 },
  INR: { rate: 100, currency_enum_id: 29963820 },
  JPY: { rate: 150, currency_enum_id: 29194085 },
  KRW: { rate: 1500, currency_enum_id: 32049645 },
  LTC: { rate: 0.01281, currency_enum_id: 19360096 },
  MKD: { rate: 50, currency_enum_id: 32633031 },
  MXN: { rate: 20, currency_enum_id: 29673542 },
  NGN: { rate: 1000, currency_enum_id: 29164363 },
  NOK: { rate: 10, currency_enum_id: 12810400 },
  NZD: { rate: 1.5, currency_enum_id: 12575539 },
  PEN: { rate: 5, currency_enum_id: 26606847 },
  PLN: { rate: 5, currency_enum_id: 29173854 },
  RSD: { rate: 100, currency_enum_id: 32619603 },
  RON: { rate: 5, currency_enum_id: 13074221 },
  SEK: { rate: 10, currency_enum_id: 13078143 }, 
  TRX: { rate: 3.74, currency_enum_id: 29132788 },
  TRY: { rate: 30, currency_enum_id: 26444896 },
  UAH: { rate: 40, currency_enum_id: 29641725 },
  USD: { rate: 1, currency_enum_id: 12002522 },
  USDC: { rate: 1, currency_enum_id: 29930419 },
  USDTE: { rate: 1, currency_enum_id: 29139820 },
  USDTT: { rate: 1, currency_enum_id: 19360149 },
  XRP: { rate: 0.5, currency_enum_id: 29131840 },
  ZAR: { rate: 20, currency_enum_id: 12619465 }
};

export const SECOND_CRM_OVERRIDES: Record<string, number> = {
  "ALL": 43722244, "AUD": 37362876, "BAM": 52031496, "BRL": 39743343, "CAD": 36582621,
  "CHF": 35780272, "COP": 54530537, "CZK": 36911114, "DKK": 38577668, "EUR": 35780262, 
  "GBP": 36906695, "HUF": 37085212, "INR": 54530544, "JPY": 54530550, "KRW": 41863984, 
  "MKD": 43720987, "MXN": 54530548, "NOK": 38373417, "NZD": 42886906, "PEN": 54530536, 
  "PLN": 35780276, "RON": 37506710, "RSD": 43720923, "TRY": 55150074, "USD": 49929665, 
  "ZAR": 54530534
};

export const THIRD_CRM_OVERRIDES: Record<string, number> = {
  "ALL": 37303531, "AUD": 32535435, "BAM": 37298012, "BRL": 37303570, "CAD": 32535224,
  "CHF": 32535226, "COP": 36970341, "CZK": 32563307, "DKK": 32991878, "EUR": 32535052,
  "HUF": 32587338, "KRW": 37301080, "MKD": 37303564, "NOK": 36401960, "NZD": 37298530,
  "PLN": 32535055, "RON": 36402591, "RSD": 37301118
};

export const FIAT_CURRENCIES = ['AUD','BAM','BGN','BRL','CAD','CHF','CLP','COP','CZK','DKK','GBP','HRK','HUF','INR','JPY','KRW','MKD','MXN','NGN','NOK','NZD','PEN','PLN','RSD','RON','SEK','TRY','UAH','USD','ZAR','ALL'];
export const CRYPTO_CODES = ['BTC','ETH','BNB','DOGE','LTC','TRX','XRP','ADA','BUSD','USDC','USDTE','USDTT','BNBSC'];
export const STABLECOINS_HARDCODED = ['BUSD','USDC','USDTE','USDTT'];
export const ALWAYS_FORCE_BLUE = ['USDTT','USDTE','USDC','BTC','BNBSC','ADA','BUSD','ETH','LTC','XRP','BNB','DOGE'];
