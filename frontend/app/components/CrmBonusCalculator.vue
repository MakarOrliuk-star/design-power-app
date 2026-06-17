<template>
  <div class="bonus-panel">
    <h3 class="panel-title">🎯 Калькулятор Бонусов</h3>
    
    <div class="calc-grid">
      <div class="calc-card">
        <h4 class="calc-card__title">Deposit Free Spins</h4>
        <div class="input-group">
          <label>Wagering</label>
          <select v-model.number="fs.wager">
            <option v-for="w in wagerOptions" :key="w" :value="w">{{ w }}</option>
          </select>
        </div>
        <div class="input-group"><label>FS amount</label><input type="number" v-model.number="fs.amount" /></div>
        <div class="input-group"><label>FS cost/spin (€)</label><input type="number" step="0.01" v-model.number="fs.costPerSpin" /></div>
        <div class="input-group"><label>Provider fee (%)</label><input type="number" v-model.number="fs.providerFee" /></div>
        <div class="input-group"><label>Deposit (€)</label><input type="number" v-model.number="fs.deposit" /></div>
        <div class="input-group"><label>Payment fee (%)</label><input type="number" v-model.number="fs.paymentFee" /></div>

        <div class="results">
          <div class="res-row"><span>FS cost (€)</span> <b>{{ fsResult.fsCostEUR }} €</b></div>
          <div class="res-row"><span>Provider Fee (€)</span> <b>{{ fsResult.providerFeePerc }} €</b></div>
          <div class="res-row"><span>FS cost after wagering</span> <b>{{ fsResult.fsCostAfterWagering }} €</b></div>
          <div class="res-row highlight-spent"><span>FS spent all (€)</span> <b>{{ fsResult.fsSpentAll }} €</b></div>
          <div class="res-row"><span>Payment Fee (€)</span> <b>{{ fsResult.paymentFeeVal }} €</b></div>
          <div class="res-row"><span>Provider Fee (€)</span> <b>{{ fsResult.providerFeeVal }} €</b></div>
          <div class="res-row"><span>Total Fees (€)</span> <b>{{ fsResult.totalFees }} €</b></div>
          <div class="res-row highlight-total"><span>Total with Deposit (€)</span> <b>{{ fsResult.totalWithDeposit }} €</b></div>
        </div>
      </div>

      <div class="calc-card">
        <h4 class="calc-card__title">Deposit Bonus</h4>
        <div class="input-group">
          <label>Wagering</label>
          <select v-model.number="db.wager">
            <option v-for="w in wagerOptions" :key="w" :value="w">{{ w }}</option>
          </select>
        </div>
        <div class="input-group"><label>Bonus %</label><input type="number" v-model.number="db.percent" /></div>
        <div class="input-group"><label>Provider fee (%)</label><input type="number" v-model.number="db.providerFee" /></div>
        <div class="input-group"><label>Deposit (€)</label><input type="number" v-model.number="db.deposit" /></div>
        <div class="input-group"><label>Payment fee (%)</label><input type="number" v-model.number="db.paymentFee" /></div>

        <div class="results">
          <div class="res-row"><span>Bonus sum (€)</span> <b>{{ dbResult.bonusSumEUR }} €</b></div>
          <div class="res-row"><span>Provider Fee (€)</span> <b>{{ dbResult.providerFeePerc }} €</b></div>
          <div class="res-row"><span>Bonus cost after wagering (€)</span> <b>{{ dbResult.bonusCostAfterWagering }} €</b></div>
          <div class="res-row highlight-spent"><span>Bonus spent all (€)</span> <b>{{ dbResult.bonusSpentAll }} €</b></div>
          <div class="res-row"><span>Payment Fee (€)</span> <b>{{ dbResult.paymentFeeVal }} €</b></div>
          <div class="res-row"><span>Provider Fee (€)</span> <b>{{ dbResult.providerFeeVal }} €</b></div>
          <div class="res-row"><span>Total Fees (€)</span> <b>{{ dbResult.totalFees }} €</b></div>
          <div class="res-row highlight-total"><span>Total with Deposit (€)</span> <b>{{ dbResult.totalWithDeposit }} €</b></div>
        </div>
      </div>

      <div class="calc-card">
        <h4 class="calc-card__title">Hybrid Bonus</h4>
        <div class="input-group">
          <label>Wagering</label>
          <select v-model.number="hy.wager">
            <option v-for="w in wagerOptions" :key="w" :value="w">{{ w }}</option>
          </select>
        </div>
        <div class="input-group"><label>Bonus %</label><input type="number" v-model.number="hy.percent" /></div>
        <div class="input-group"><label>FS amount</label><input type="number" v-model.number="hy.amount" /></div>
        <div class="input-group"><label>FS cost/spin (€)</label><input type="number" step="0.01" v-model.number="hy.costPerSpin" /></div>
        <div class="input-group"><label>Provider fee (%)</label><input type="number" v-model.number="hy.providerFee" /></div>
        <div class="input-group"><label>Deposit (€)</label><input type="number" v-model.number="hy.deposit" /></div>
        <div class="input-group"><label>Payment fee (%)</label><input type="number" v-model.number="hy.paymentFee" /></div>

        <div class="results">
          <div class="res-row"><span>Bonus sum (€)</span> <b>{{ hyResult.bonusSumEUR }} €</b></div>
          <div class="res-row"><span>FS cost (€)</span> <b>{{ hyResult.fsCostEUR }} €</b></div>
          <div class="res-row"><span>Provider Fee (€)</span> <b>{{ hyResult.providerFeePerc }} €</b></div>
          <div class="res-row"><span>Bonus cost after wagering (€)</span> <b>{{ hyResult.bonusCostAfterWagering }} €</b></div>
          <div class="res-row highlight-spent"><span>Bonus spent all (€)</span> <b>{{ hyResult.bonusSpentAll }} €</b></div>
          <div class="res-row"><span>Payment Fee (€)</span> <b>{{ hyResult.paymentFeeVal }} €</b></div>
          <div class="res-row"><span>Provider Fee (€)</span> <b>{{ hyResult.providerFeeVal }} €</b></div>
          <div class="res-row"><span>Total Fees (€)</span> <b>{{ hyResult.totalFees }} €</b></div>
          <div class="res-row highlight-total"><span>Total with Deposit (€)</span> <b>{{ hyResult.totalWithDeposit }} €</b></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

// Constants strictly mapped from GAS script
const RTP = 0.955;
const BonusWageringFactor = 5;
const MoneyWageringFactor = 12;
const wagerOptions = [1, 5, 10, 15, 20, 25, 30, 35, 40];
const wagerMap = {1: 0.80, 5: 0.75, 10: 0.65, 15: 0.65, 20: 0.60, 25: 0.60, 30: 0.60, 35: 0.55, 40: 0.55};

// Default States
const fs = ref({ wager: 10, amount: 30, costPerSpin: 0.1, providerFee: 10, deposit: 50, paymentFee: 10 });
const db = ref({ wager: 10, percent: 100, providerFee: 10, deposit: 40, paymentFee: 10 });
const hy = ref({ wager: 10, percent: 100, amount: 30, costPerSpin: 0.1, providerFee: 10, deposit: 50, paymentFee: 10 });

// Helper function to format numbers precisely
const fmt = (num) => Number(num || 0).toFixed(2);

// 1. Free Spins Logic
const fsResult = computed(() => {
  const wagerDone = wagerMap[fs.value.wager] || 0.6;
  const gameProviderFee = fs.value.providerFee / 100;
  const paymentFee = fs.value.paymentFee / 100;

  const fsCostEUR = fs.value.amount * fs.value.costPerSpin * RTP;
  const providerFeePerc = ((BonusWageringFactor * fsCostEUR) * 0.045) * gameProviderFee;
  const fsCostAfterWagering = (fsCostEUR * wagerDone) * 0.6;
  const fsSpentAll = fsCostAfterWagering + providerFeePerc;
  
  const paymentFeeVal = fs.value.deposit * paymentFee;
  const providerFeeVal = ((fs.value.deposit * MoneyWageringFactor) * 0.045) * gameProviderFee;
  
  const totalFees = paymentFeeVal + providerFeeVal + fsSpentAll;
  const totalWithDeposit = fs.value.deposit - totalFees;

  return {
    fsCostEUR: fmt(fsCostEUR),
    providerFeePerc: fmt(providerFeePerc),
    fsCostAfterWagering: fmt(fsCostAfterWagering),
    fsSpentAll: fmt(fsSpentAll),
    paymentFeeVal: fmt(paymentFeeVal),
    providerFeeVal: fmt(providerFeeVal),
    totalFees: fmt(totalFees),
    totalWithDeposit: fmt(totalWithDeposit)
  };
});

// 2. Deposit Bonus Logic
const dbResult = computed(() => {
  const wagerDone = wagerMap[db.value.wager] || 0.6;
  const gameProviderFee = db.value.providerFee / 100;
  const paymentFee = db.value.paymentFee / 100;

  const bonusSumEUR = db.value.deposit * (db.value.percent / 100);
  const providerFeePerc = ((BonusWageringFactor * bonusSumEUR) * 0.045) * gameProviderFee;
  const bonusCostAfterWagering = (bonusSumEUR * wagerDone) * 0.6;
  const bonusSpentAll = bonusCostAfterWagering + providerFeePerc;
  
  const paymentFeeVal = db.value.deposit * paymentFee;
  const providerFeeVal = ((db.value.deposit * MoneyWageringFactor) * 0.045) * gameProviderFee;
  
  const totalFees = paymentFeeVal + providerFeeVal + bonusSpentAll;
  const totalWithDeposit = db.value.deposit - totalFees;

  return {
    bonusSumEUR: fmt(bonusSumEUR),
    providerFeePerc: fmt(providerFeePerc),
    bonusCostAfterWagering: fmt(bonusCostAfterWagering),
    bonusSpentAll: fmt(bonusSpentAll),
    paymentFeeVal: fmt(paymentFeeVal),
    providerFeeVal: fmt(providerFeeVal),
    totalFees: fmt(totalFees),
    totalWithDeposit: fmt(totalWithDeposit)
  };
});

// 3. Hybrid Logic
const hyResult = computed(() => {
  const wagerDone = wagerMap[hy.value.wager] || 0.6;
  const gameProviderFee = hy.value.providerFee / 100;
  const paymentFee = hy.value.paymentFee / 100;

  const bonusSumEUR = hy.value.deposit * (hy.value.percent / 100);
  const fsCostEUR = hy.value.amount * hy.value.costPerSpin * RTP;
  const providerFeePerc = ((BonusWageringFactor * (bonusSumEUR + fsCostEUR)) * 0.045) * gameProviderFee;
  const bonusCostAfterWagering = (bonusSumEUR * wagerDone) * 0.6;
  const bonusSpentAll = bonusCostAfterWagering + providerFeePerc;
  
  const paymentFeeVal = hy.value.deposit * paymentFee;
  const providerFeeVal = ((hy.value.deposit * MoneyWageringFactor) * 0.045) * gameProviderFee;
  
  const totalFees = paymentFeeVal + providerFeeVal + bonusSpentAll;
  const totalWithDeposit = hy.value.deposit - totalFees;

  return {
    bonusSumEUR: fmt(bonusSumEUR),
    fsCostEUR: fmt(fsCostEUR),
    providerFeePerc: fmt(providerFeePerc),
    bonusCostAfterWagering: fmt(bonusCostAfterWagering),
    bonusSpentAll: fmt(bonusSpentAll),
    paymentFeeVal: fmt(paymentFeeVal),
    providerFeeVal: fmt(providerFeeVal),
    totalFees: fmt(totalFees),
    totalWithDeposit: fmt(totalWithDeposit)
  };
});
</script>

<style scoped>
.bonus-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.panel-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--color-text);
}

/* Три карточки всегда в один ряд и ужимаются по ширине экрана.
   minmax(0, 1fr) разрешает колонкам сжиматься ниже контента — без
   переноса и горизонтального скролла. */
.calc-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  align-items: stretch;
}

.calc-card {
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 12px);
  padding: 18px;
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.calc-card__title {
  margin: 0 0 10px 0;
  font-size: 16px;
  font-weight: 600;
  text-align: center;
  color: var(--color-text);
}

.input-group {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.input-group label {
  color: var(--color-grey);
  font-weight: 500;
}

/* Enhanced input and dropdown inputs for maximum contrast and legibility */
.input-group input, 
.input-group select {
  width: 120px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-family: monospace;
  font-size: 13px;
  outline: none;
  background: #ffffff; 
  color: #0f172a;      /* Enforced dark text to prevent blending with light background */
}

.input-group input:focus, 
.input-group select:focus {
  border-color: var(--color-grey);
}

/* Enforced explicit dark options inside dropdown context */
.input-group select option {
  background: #ffffff;
  color: #0f172a;
}

/* Transformed results wrapper into a sleek native dark-mode panel */
.results {
  margin-top: 12px;
  padding: 12px;
  background: #1e293b; 
  border: 1px solid #334155;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}

.res-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 6px;
  border-bottom: 1px solid #334155;
}
.res-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.res-row span {
  color: #94a3b8; /* Muted text label for dark mode */
}

.res-row b {
  font-family: monospace;
  color: #f8fafc; /* Crisp white for values */
}

/* Smooth pastel-red glow highlight for spent rows */
.highlight-spent {
  background-color: rgba(239, 68, 68, 0.15); 
  border: 1px solid rgba(239, 68, 68, 0.3);
  padding: 4px 8px;
  border-radius: 6px;
}
.highlight-spent span {
  color: #fca5a5;
}
.highlight-spent b {
  color: #ef4444;
}

/* Smooth pastel-green glow highlight for total rows */
.highlight-total {
  background-color: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
  padding: 4px 8px;
  border-radius: 6px;
}
.highlight-total span {
  color: #a7f3d0;
}
.highlight-total b {
  color: #10b981;
}
</style>