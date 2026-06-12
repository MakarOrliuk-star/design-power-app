<template>
  <div class="calculator-panel">
    <h3 class="panel-title">💶 Валютный калькулятор</h3>
    
    <div class="controls-bar">
      <input 
        v-model.number="amount" 
        type="number" 
        step="0.01"
        min="0.01"
        class="amount-input"
        @keydown.enter="doConvert"
      />
      <button @click="doConvert" class="btn btn--primary">Convert</button>
      <button @click="handleMassCopy(data?.outputList)" class="btn btn--env2">Copy for ENV-2</button>
      <button @click="handleMassCopy(data?.secondCrmList)" class="btn btn--env5">Copy for ENV-5</button>
      <button @click="handleMassCopy(data?.thirdCrmList)" class="btn btn--env7">Copy for ENV-7</button>

      <div class="manual-toggle">
        <input type="checkbox" id="manualMode" v-model="manualCopyMode" class="checkbox" />
        <label for="manualMode" class="checkbox-label">Manual Copy Mode</label>
      </div>
    </div>

    <div v-if="status" :class="['status-msg', isError ? 'status-msg--err' : 'status-msg--ok']">
      {{ status }}
    </div>

    <div v-if="data" class="currency-grid">
      <div 
        v-for="c in data.outputList" 
        :key="c.currency_name"
        :style="{ backgroundColor: c.bgColor }"
        class="currency-card"
      >
        <div class="currency-card__name">{{ c.currency_name }}</div>
        <div class="currency-card__value">
          {{ c.value }} {{ CURRENCY_SYMBOLS[c.currency_name] || c.currency_name }}
        </div>

        <div class="currency-card__actions">
          <button @click="dispatchCopy(`${c.value} ${CURRENCY_SYMBOLS[c.currency_name] || c.currency_name}`)" title="С точкой" class="action-btn">•</button>
          <button @click="dispatchCopy(`${c.value.replace('.', ',')} ${CURRENCY_SYMBOLS[c.currency_name] || c.currency_name}`)" title="С запятой" class="action-btn">❜</button>
          <button @click="dispatchCopy(c.value)" title="Только число" class="action-btn action-btn--num">◇</button>
        </div>
      </div>
    </div>

    <Transition name="fade">
      <div v-if="showToast" class="toast-popup">Copied!</div>
    </Transition>

    <div v-if="modalVisible" class="modal-overlay">
      <div class="modal-card">
        <h4>Manual Copy</h4>
        <p>Нажмите Ctrl+C (или Cmd+C), чтобы скопировать текст.</p>
        <textarea ref="modalTextarea" v-model="modalText" readonly class="modal-textarea"></textarea>
        <button @click="modalVisible = false" class="btn btn--close">Close</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue';


const CURRENCY_SYMBOLS = {
  EUR:'€', USD:'$', GBP:'£', JPY:'¥', AUD:'AU$', BAM:'KM', CAD:'CA$', CHF:'CHF', CNY:'¥', SEK:'kr', NZD:'NZ$', MXN:'$', BRL:'R$', RUB:'₽', INR:'INR',
  KRW:'₩', ZAR:'R', DKK:'kr.', NOK:'kr', PLN:'zł', TRY:'₺', CZK:'Kč', HUF:'Ft', ILS:'₪', CLP:'$', COP:'COL$', PEN:'S/', ARS:'$', AED:'د.إ',
  ALL:'lekë', BGN:'лв.', HRK:'kn', MKD:'ден', NGN:'₦', RON:'lei', RSD:'din', UAH:'₴',
  BTC:'BTC', ETH:'ETH', BNB:'BNB', DOGE:'DOGE', LTC:'LTC', TRX:'TRX', XRP:'XRP', ADA:'ADA',
  BUSD:'BUSD', USDC:'USDC', USDTE:'USDTE', USDTT:'USDTT', BNBSC:'BNB'
};

const amount = ref(100);
const data = ref(null);
const status = ref('');
const isError = ref(false);
const manualCopyMode = ref(false);
const showToast = ref(false);
const modalVisible = ref(false);
const modalText = ref('');
const modalTextarea = ref(null);

const api = useApi(); // Работает напрямую через авто-импорт

async function doConvert() {
  if (isNaN(amount.value) || amount.value <= 0) {
    status.value = 'Enter a positive amount in EUR.';
    isError.value = true;
    return;
  }
  status.value = 'Calculating…';
  isError.value = false;

  try {
    data.value = await api('/api/calculator/convert', {
      method: 'POST',
      body: { amount: amount.value }
    });
    status.value = 'Done';
  } catch (err) {
    status.value = 'Error: ' + (err.data?.error || err.message || 'server_error');
    isError.value = true;
  }
}

function triggerToast() {
  showToast.value = true;
  setTimeout(() => { showToast.value = false; }, 1200);
}

function dispatchCopy(text) {
  if (manualCopyMode.value) {
    modalText.value = text;
    modalVisible.value = true;
    nextTick(() => { modalTextarea.value?.select(); });
  } else {
    navigator.clipboard.writeText(text)
      .then(() => triggerToast())
      .catch(() => {
        modalText.value = text;
        modalVisible.value = true;
      });
  }
}

function handleMassCopy(list) {
  if (!list || list.length === 0) return;

  // Clean the payload: keep only the required fields
  const cleanPayload = list.map(item => ({
    value: item.value,
    currency_enum_id: item.currency_enum_id,
    currency_name: item.currency_name
  }));

  dispatchCopy(JSON.stringify(cleanPayload));
}

onMounted(() => { doConvert(); });
</script>

<style scoped>
.calculator-panel {
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
.controls-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  background: transparent;
  border: none;
  padding: 12px;
  border-radius: var(--radius-lg, 12px);
  border: 1px solid var(--color-border);
}
.amount-input {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill, 99px);
  padding: 8px 16px;
  width: 120px;
  font-family: monospace;
  font-weight: bold;
  outline: none;
}
.amount-input:focus {
  border-color: var(--color-grey);
}
.btn {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill, 99px);
  padding: 8px 18px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  background: var(--color-white);
  color: var(--color-text);
  transition: all 0.15s ease;
}
.btn:hover { opacity: 0.9; transform: translateY(-0.5px); }
.btn--primary { background: #1e293b; color: white; border: none; }
.btn--env2 { background: #10b981; color: white; border: none; }
.btn--env5 { background: #f59e0b; color: #1e293b; border: none; }
.btn--env7 { background: #3b82f6; color: white; border: none; }

.manual-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.checkbox { width: 16px; height: 16px; cursor: pointer; }
.checkbox-label { font-size: 13px; color: var(--color-grey); cursor: pointer; user-select: none; }

.status-msg { font-size: 13px; font-weight: 600; }
.status-msg--ok { color: #10b981; }
.status-msg--err { color: #ef4444; }

.currency-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
  /* --- NEW: Enable vertical scrolling for the grid --- */
  overflow-y: auto;
  max-height: calc(100vh - 280px); /* Keeps the grid inside the viewport */
  padding-right: 6px; /* Adds space for the scrollbar */
}

currency-grid::-webkit-scrollbar {
  width: 6px;
}
.currency-grid::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 4px;
}

.currency-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 12px);
  padding: 10px;
  text-align: center;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  box-shadow: var(--shadow-card);
}
.currency-card__name { font-size: 12px; font-weight: bold; color: var(--color-grey); text-transform: uppercase; }
.currency-card__value { font-family: monospace; font-weight: bold; font-size: 14px; margin: 8px 0; color: #1e293b; }
.currency-card__actions { display: flex; justify-content: center; gap: 4px; }

.action-btn {
  background: var(--color-white);
  border: 1px solid var(--color-border);
  padding: 3px 8px;
  font-size: 11px;
  font-weight: bold;
  border-radius: 6px;
  cursor: pointer;
  color: var(--color-text);
}
.action-btn:hover { border-color: var(--color-grey); }
.action-btn--num { background: #10b981; color: white; border: none; }

.toast-popup {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  background: #1e293b; color: #fff; padding: 8px 20px; border-radius: var(--radius-pill, 99px);
  font-size: 13px; font-weight: 500; z-index: 3000; box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4); backdrop-filter: blur(2px);
  display: flex; justify-content: center; align-items: center; z-index: 4000;
}
.modal-card {
  background: white; padding: 24px; border-radius: var(--radius-lg);
  max-width: 400px; width: 100%; text-align: center; box-shadow: var(--shadow-card);
}
.modal-card h4 { margin: 0 0 6px 0; font-size: 18px; }
.modal-card p { font-size: 12px; color: var(--color-grey); margin-bottom: 12px; }
.modal-textarea { width: 100%; height: 100px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: 10px; font-family: monospace; resize: none; margin-bottom: 12px; outline: none; box-sizing: border-box; }
.btn--close { width: 100%; background: #f1f5f9; border: none; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
