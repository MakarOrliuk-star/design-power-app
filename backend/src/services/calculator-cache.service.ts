// src/services/calculator-cache.service.ts
import { redis, ensureRedis } from "../lib/redis.js";
import { FIAT_CURRENCIES } from "../config/calculator.config.js";

export const calculatorCache = {
  async getRate(currency: string): Promise<number | null> {
    await ensureRedis(); 
    const lookupCode = currency === 'BNBSC' ? 'BNB' : currency;
    const raw = await redis.get(`rate:${lookupCode}`);
    if (!raw) return null;
    
    try {
      const obj = JSON.parse(raw);
      const ttl = FIAT_CURRENCIES.includes(lookupCode) ? 7 * 24 * 60 * 60 : 24 * 60 * 60;
      const now = Math.floor(Date.now() / 1000);
      
      if ((now - obj.t) < ttl) return obj.r;
    } catch (e) {
      return null;
    }
    return null;
  },

  async setRate(currency: string, rate: number): Promise<void> {
    await ensureRedis();
    const lookupCode = currency === 'BNBSC' ? 'BNB' : currency;
    const ttl = FIAT_CURRENCIES.includes(lookupCode) ? 7 * 24 * 60 * 60 : 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);
    
    await redis.setex(
      `rate:${lookupCode}`, 
      ttl, 
      JSON.stringify({ r: rate, t: now })
    );
  }
};