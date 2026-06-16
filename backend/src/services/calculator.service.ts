import { calculatorCache } from "./calculator-cache.service.js";
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
    
    for (const code of codes) {
      if (code === 'BNBSC') continue;
      if (STABLECOINS_HARDCODED.includes(code)) {
        await calculatorCache.setRate(code, 1.0);
        continue;
      }

      try {
        const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${code}&tsym=EUR&limit=2&api_key=${apiKey}`;
        const resp = await globalThis.fetch(url);
        if (resp.status === 200) {
          const d: any = await resp.json();
          const bars = d?.Data?.Data;
          if (Array.isArray(bars) && bars.length >= 2) {
            const close = bars[1]?.close;
            if (close && close > 0) {
              await calculatorCache.setRate(code, 1 / close);
            }
          }
        }
      } catch (e) {
        console.error(`❌ Crypto rate fetch error for ${code}`);
      }
    }
  },

  async convertCurrency(amountEur: number) {
    const amt = parseFloat(amountEur.toString());
    if (isNaN(amt) || amt <= 0) {
      throw new Error("Enter an amount in EUR.");
    }

    const missingCrypto = [];
    for (const c of CRYPTO_CODES) {
      const rate = await calculatorCache.getRate(c);
      if (CURRENCY_DATA[c] && rate === null) missingCrypto.push(c);
    }
    if (missingCrypto.length > 0) {
      await this.fetchCryptoRates(missingCrypto);
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