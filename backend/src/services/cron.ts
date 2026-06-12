import cron from 'node-cron';
import { calculatorService } from './calculator.service.js';
import { CRYPTO_CODES } from '../config/calculator.config.js';
import { calculatorCache } from './calculator-cache.service.js';

export async function initCronJobs() {
  // Check cache on server startup to prevent empty data issues
  try {
    const hasFiat = await calculatorCache.getRate('USD');
    const hasCrypto = await calculatorCache.getRate('BTC');

    if (!hasFiat) {
      await calculatorService.fetchFiatRates();
    }
    
    if (!hasCrypto) {
      await calculatorService.fetchCryptoRates(CRYPTO_CODES);
    }
  } catch (err) {
    console.error('Cache warmup failed:', err);
  }

  // Update crypto daily at 00:05
  cron.schedule('5 0 * * *', async () => {
    try {
      await calculatorService.fetchCryptoRates(CRYPTO_CODES);
    } catch (err) {
      console.error('Crypto cron failed:', err);
    }
  });

  // Update fiat weekly on Monday at 00:00
  cron.schedule('0 0 * * 1', async () => {
    try {
      await calculatorService.fetchFiatRates();
    } catch (err) {
      console.error('Fiat cron failed:', err);
    }
  });
}