import { calculatorCache } from "./calculator-cache.service.js";
import { redis } from "../lib/redis.js"; // Добавлен импорт redis для хранения таймстампов
import { 
  CURRENCY_DATA, FIAT_CURRENCIES, CRYPTO_CODES, STABLECOINS_HARDCODED,
  SECOND_CRM_OVERRIDES, THIRD_CRM_OVERRIDES, ALWAYS_FORCE_BLUE
} from "../config/calculator.config.js";

export const calculatorService = {
  
  async sendSlackNotification(message: string, title = "🚨 Alert"): Promise<void> {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_CHANNEL_ID;

    if (!token || !channel) {
      console.error("❌ Slack configuration missing in environment variables");
      return;
    }

    try {
      await globalThis.fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          channel,
          text: title,
          blocks: [{
            type: "section",
            text: { type: "mrkdwn", text: `*${title}*\n\n${message}` }
          }]
        })
      });
    } catch (e) {
      console.error("❌ Slack notification error:", e);
    }
  },

  async checkAndRefreshRates(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const ONE_DAY = 24 * 60 * 60;

    try {
      const lastFiat = await redis.get("rate:last_fiat_api_fetch");
      const lastFiatTime = lastFiat ? parseInt(lastFiat, 10) : 0;
      
      if (now - lastFiatTime >= ONE_DAY) {
        console.log("🔄 Делаем плановый запрос к Fiat API...");
        await this.fetchFiatRates();
        await redis.set("rate:last_fiat_api_fetch", now.toString());
      } else {
        const remainingMin = Math.round((ONE_DAY - (now - lastFiatTime)) / 60);
        console.log(`ℹ️ Fiat API актуален. Запрос пропущен. Следующий через: ${remainingMin} мин.`);
      }

      const lastCrypto = await redis.get("rate:last_crypto_api_fetch");
      const lastCryptoTime = lastCrypto ? parseInt(lastCrypto, 10) : 0;

      if (now - lastCryptoTime >= ONE_DAY) {
        console.log("🔄 Делаем плановый запрос к Crypto API...");
        await this.fetchCryptoRates(CRYPTO_CODES);
        await redis.set("rate:last_crypto_api_fetch", now.toString());
      } else {
        const remainingMin = Math.round((ONE_DAY - (now - lastCryptoTime)) / 60);
        console.log(`ℹ️ Crypto API актуален. Запрос пропущен. Следующий через: ${remainingMin} мин.`);
      }
    } catch (e) {
      console.error("❌ Ошибка при проверке расписания курсов валют:", e);
    }
  },

  async fetchFiatRates(): Promise<any> {
    try {
      const url = `https://api.frankfurter.app/latest?base=EUR&symbols=${FIAT_CURRENCIES.join(',')}`;
      const resp = await globalThis.fetch(url);
      if (resp.status !== 200) return null;
      
      const d: any = await resp.json();
      if (d && d.rates) {
        for (const c in d.rates) {
          await calculatorCache.setRate(c, d.rates[c]);
        }
        return d.rates;
      }
    } catch (e) {
      console.error("⚠️ FX fetch error (frankfurter)");
    }
    return null;
  },

  async fetchCryptoRates(codes: string[]): Promise<void> {
    const apiKey = process.env.CRYPTO_COMPARE_API_KEY;

    if (!apiKey) {
      console.error("❌ CryptoCompare API key missing in environment variables");
      return;
    }

    const cleanCodes: string[] = [];
    
    for (const code of codes) {
      if (code === 'BNBSC') continue;
      if (STABLECOINS_HARDCODED.includes(code)) {
        await calculatorCache.setRate(code, 1.0);
        continue;
      }
      cleanCodes.push(code);
    }

    if (cleanCodes.length === 0) return;

    try {
      const fsyms = cleanCodes.join(',');
      const url = `https://min-api.cryptocompare.com/data/pricemulti?fsyms=${fsyms}&tsyms=EUR&api_key=${apiKey}`;
      
      const resp = await globalThis.fetch(url);
      if (resp.status === 200) {
        const data: any = await resp.json();
        
        for (const code of cleanCodes) {
          const price = data[code]?.EUR;
          if (price && price > 0) {
            await calculatorCache.setRate(code, 1 / price);
          } else {
            console.warn(`⚠️ No rate returned from CryptoCompare for ${code}`);
          }
        }
      } else {
        console.error(`❌ CryptoCompare API error. Status: ${resp.status}`);
      }
    } catch (e) {
      console.error(`❌ Crypto rate batch fetch error:`, e);
    }
  },

  async convertCurrency(amountEur: number) {
    const amt = parseFloat(amountEur.toString());
    if (isNaN(amt) || amt <= 0) {
      throw new Error("Enter an amount in EUR.");
    }

  

    const realRates: Record<string, number> = {};
    for (const c of [...CRYPTO_CODES, ...FIAT_CURRENCIES]) {
      const r = await calculatorCache.getRate(c);
      if (CURRENCY_DATA[c] && r !== null) realRates[c] = r;
    }

    const allCurrencies: any[] = [];
    const currencyJsonData: Record<string, string> = {};

    (Object.keys(CURRENCY_DATA) as Array<keyof typeof CURRENCY_DATA>).sort().forEach(c => {
      const d = CURRENCY_DATA[c];
      if (!d) return;

      const isCrypto = CRYPTO_CODES.includes(c);
      const forceBlue = ALWAYS_FORCE_BLUE.includes(c);
      
      let bgColor = "#e8f5e9"; 
      const useRate = STABLECOINS_HARDCODED.includes(c) ? 1.0 :
                      FIAT_CURRENCIES.includes(c) ? d.rate :
                      (realRates[c] != null && (isCrypto || forceBlue)) ? realRates[c] : d.rate;
      
      const conv = amt * useRate;
      const deviation = realRates[c] ? Math.abs((d.rate - realRates[c]) / realRates[c]) * 100 : 0;

      if (forceBlue || isCrypto) {
        bgColor = "#e3f2fd"; 
      } else if (deviation >= 45) {
        bgColor = "#ffebee"; 
      }

      const decimals = conv < 0.01 ? 8 : (conv < 1 ? 4 : 2);
      const valDot = parseFloat(conv.toFixed(decimals)).toString();
      const valComma = valDot.replace('.', ',');

      allCurrencies.push({ 
        currency_enum_id: d.currency_enum_id, 
        value: valDot, 
        currency_name: c,
        bgColor 
      });
      
      currencyJsonData[`${c}_dot`] = valDot;
      currencyJsonData[`${c}_comma`] = valComma;
    });

    const byName: Record<string, any> = {};
    allCurrencies.forEach(item => { byName[item.currency_name] = item; });

    const mapCrmList = (overrides: Record<string, number>) => {
      const list = [];
      for (const curName in overrides) {
        const src = byName[curName];
        if (src) {
          list.push({ value: src.value, currency_name: curName, currency_enum_id: overrides[curName] });
        }
      }
      return list;
    };

    return {
      currencyJsonData,
      outputList: allCurrencies,
      secondCrmList: mapCrmList(SECOND_CRM_OVERRIDES),
      thirdCrmList: mapCrmList(THIRD_CRM_OVERRIDES)
    };
  }
};