<template>
  <div class="auditor-panel">
    
    <div class="auditor-card token-card">
      <div class="card-header">
        <h3 class="card-title">🔑 Доступ к Smartico</h3>
        <span class="status-badge" :class="token ? 'status-ok' : 'status-err'">
          {{ token ? 'Токен сохранен' : 'Токен не задан' }}
        </span>
      </div>
      <div class="input-row">
        <input 
          type="password" 
          v-model="tokenInput" 
          placeholder="Вставьте ваш Auth Token..." 
          class="crm-input flex-1"
        />
        <button @click="saveToken" class="crm-btn crm-btn-primary">Сохранить</button>
        <button @click="clearToken" v-if="token" class="crm-btn crm-btn-danger">Сбросить</button>
      </div>
    </div>

    <div class="auditor-card form-card" :class="{ 'disabled-card': !token || isAuditing }">
      <h3 class="card-title mb-4">🗺️ Настройки кампаний</h3>
      
      <div class="inputs-grid">
        <div class="input-group">
          <label>📅 Scheduled кампания (URL)</label>
          <input type="text" v-model="mainUrl" placeholder="https://drive.smartico.ai/..." class="crm-input" :disabled="!token || isAuditing" />
        </div>
        
        <div class="input-group">
          <label>🎯 Journey кампания / Pop-up (URL)</label>
          <input type="text" v-model="popUrl" placeholder="https://drive.smartico.ai/..." class="crm-input" :disabled="!token || isAuditing" />
        </div>
      </div>

      <div class="settings-row mt-4">
        <label class="checkbox-label">
          <input type="checkbox" v-model="useStats" :disabled="!token || isAuditing" />
          <span>📈 Собрать статистику Flow Map (Live View)</span>
        </label>
        
        <div class="days-input" v-if="useStats">
          <label>Дней назад:</label>
          <input type="number" v-model="daysBack" min="1" max="90" class="crm-input min-w-[80px]" :disabled="!token || isAuditing" />
        </div>
      </div>

      <button @click="startAudit" class="crm-btn crm-btn-success run-btn mt-5" :disabled="!token || isAuditing || (!mainUrl && !popUrl)">
        {{ isAuditing ? 'Анализирую...' : '🚀 Запустить аудит' }}
      </button>
    </div>

    <div class="auditor-card terminal-card" v-if="isAuditing || logs.length > 0">
      <div class="progress-wrapper">
        <div class="progress-bar" :style="{ width: progress + '%' }"></div>
      </div>
      <div class="progress-text">{{ progress }}%</div>
      
      <div class="terminal" ref="terminalRef">
        <div v-for="(log, idx) in logs" :key="idx" class="terminal-line" v-html="log"></div>
      </div>
    </div>

    <div class="auditor-card result-card" v-if="finalHtml && !isAuditing">
      <div class="result-content">
        <div class="result-icon">✅</div>
        <div class="result-text">
          <h3>Отчет успешно сгенерирован!</h3>
          <p>HTML-файл содержит интерактивную карту, контент и анализ ошибок.</p>
        </div>
        <button @click="downloadHtml" class="crm-btn crm-btn-primary download-btn">
          📥 Скачать отчет
        </button>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, onMounted, nextTick, watch } from 'vue';

// State
const token = ref('');
const tokenInput = ref('');
const mainUrl = ref('');
const popUrl = ref('');
const useStats = ref(true);
const daysBack = ref(14);

// Audit State
const isAuditing = ref(false);
const progress = ref(0);
const logs = ref([]);
const finalHtml = ref('');
const terminalRef = ref(null);

// Local Storage for Token
onMounted(() => {
  const savedToken = localStorage.getItem('smartico_qa_token');
  if (savedToken) {
    token.value = savedToken;
    tokenInput.value = savedToken;
  }
});

function saveToken() {
  if (tokenInput.value.trim()) {
    token.value = tokenInput.value.trim();
    localStorage.setItem('smartico_qa_token', token.value);
  }
}

function clearToken() {
  token.value = '';
  tokenInput.value = '';
  localStorage.removeItem('smartico_qa_token');
}

// Auto-scroll terminal
watch(logs, async () => {
  await nextTick();
  if (terminalRef.value) {
    terminalRef.value.scrollTop = terminalRef.value.scrollHeight;
  }
}, { deep: true });

// SSE Fetch Logic
async function startAudit() {
  if (!mainUrl.value && !popUrl.value) return;
  
  isAuditing.value = true;
  progress.value = 0;
  logs.value = [];
  finalHtml.value = '';

  try {
    // ЗАМЕНИ URL НА СВОЙ ПРОДОВСКИЙ ПОСЛЕ ДЕПЛОЯ НА RAILWAY
    const response = await fetch('http://localhost:8000/audit/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        main_url: mainUrl.value.trim(),
        pop_url: popUrl.value.trim(),
        token: token.value,
        use_stats: useStats.value,
        days_back: daysBack.value
      })
    });

    if (!response.ok) {
      throw new Error(`Ошибка сервера: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.replace('data: ', '').trim();
          if (!dataStr) continue;

          try {
            const parsed = JSON.parse(dataStr);

            if (parsed.type === 'progress') {
              logs.value.push(`<span class="log-time">>></span> ${parsed.msg}`);
              progress.value = parsed.percent;
            } else if (parsed.type === 'done') {
              finalHtml.value = parsed.html;
              progress.value = 100;
              logs.value.push(`<span class="log-success">>> ✅ Аудит завершен!</span>`);
              isAuditing.value = false;
            } else if (parsed.type === 'error') {
              logs.value.push(`<span class="log-err">>> ❌ Ошибка: ${parsed.msg}</span>`);
              isAuditing.value = false;
              
              // Если ошибка в авторизации - сбрасываем токен
              if (parsed.msg.includes('401') || parsed.msg.includes('доступ')) {
                clearToken();
              }
            }
          } catch (e) {
            console.error("Ошибка парсинга чанка:", e, dataStr);
          }
        }
      }
    }
  } catch (err) {
    logs.value.push(`<span class="log-err">>> ❌ Сетевая ошибка: ${err.message}</span>`);
    isAuditing.value = false;
  }
}

function downloadHtml() {
  if (!finalHtml.value) return;
  const blob = new Blob([finalHtml.value], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  
  // Достаем ID из первой попавшейся ссылки для красивого имени
  const idMatch = (mainUrl.value || popUrl.value).match(/(\d+)$/);
  const campId = idMatch ? idMatch[1] : 'Report';
  
  a.download = `Smartico_Audit_${campId}_${new Date().getTime()}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<style scoped>
.auditor-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 900px;
  margin: 0 auto;
}

.auditor-card {
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 12px);
  padding: 24px;
  box-shadow: var(--shadow-card);
}

.disabled-card {
  opacity: 0.6;
  pointer-events: none;
  filter: grayscale(40%);
  transition: all 0.3s ease;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 12px;
}

.card-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
}

.status-badge {
  font-size: 12px;
  font-weight: bold;
  padding: 4px 10px;
  border-radius: 20px;
}
.status-ok { background: #dcfce7; color: #166534; }
.status-err { background: #fee2e2; color: #991b1b; }

.input-row { display: flex; gap: 10px; }
.flex-1 { flex: 1; }

.inputs-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.input-group label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-grey);
  margin-bottom: 6px;
}

.crm-input {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
  background: #f8fafc;
}
.crm-input:focus { border-color: #3b82f6; }

.settings-row {
  display: flex;
  align-items: center;
  gap: 24px;
  background: #f1f5f9;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  color: var(--color-text);
}

.days-input {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-grey);
}
.min-w-\[80px\] { min-width: 80px; }

.crm-btn {
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: all 0.2s ease;
}
.crm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.crm-btn-primary { background: #3b82f6; color: white; }
.crm-btn-primary:hover:not(:disabled) { background: #2563eb; }
.crm-btn-danger { background: #ef4444; color: white; }
.crm-btn-danger:hover:not(:disabled) { background: #dc2626; }
.crm-btn-success { background: #10b981; color: white; }
.crm-btn-success:hover:not(:disabled) { background: #059669; }
.run-btn { width: 100%; font-size: 16px; padding: 14px; }

/* Терминал */
.terminal-card { background: #0f172a; border-color: #1e293b; }
.progress-wrapper {
  width: 100%;
  height: 6px;
  background: #1e293b;
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 8px;
}
.progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #10b981);
  transition: width 0.3s ease;
}
.progress-text {
  color: #94a3b8;
  font-size: 12px;
  text-align: right;
  margin-bottom: 12px;
  font-family: monospace;
}

.terminal {
  background: #020617;
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 16px;
  height: 250px;
  overflow-y: auto;
  font-family: 'Courier New', Courier, monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #e2e8f0;
}
.terminal-line { margin-bottom: 4px; }
:deep(.log-time) { color: #64748b; }
:deep(.log-success) { color: #10b981; font-weight: bold; }
:deep(.log-err) { color: #ef4444; font-weight: bold; }

/* Результат */
.result-card { background: #f0fdf4; border-color: #86efac; }
.result-content {
  display: flex;
  align-items: center;
  gap: 20px;
}
.result-icon { font-size: 32px; }
.result-text h3 { margin: 0 0 4px 0; color: #166534; font-size: 18px; }
.result-text p { margin: 0; color: #15803d; font-size: 13px; }
.download-btn { margin-left: auto; background: #15803d; }
.download-btn:hover { background: #166534; }
</style>