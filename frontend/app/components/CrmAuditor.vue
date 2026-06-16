<template>
  <div class="auditor-panel">
    
    <div class="auditor-card token-card">
      <details>
        <summary>
          <div class="flex items-center gap-3">
            <span>🔑 Smartico Auth Tokens Configuration</span>
            <span class="status-pill" :class="hasAnyToken ? 'pill-green' : 'pill-red'">
              {{ hasAnyToken ? 'Configured' : 'No tokens saved' }}
            </span>
          </div>
        </summary>
        <div class="token-inputs-grid mt-4">
          <div v-for="env in ['env2', 'env5', 'env7']" :key="env" class="token-row">
            <label class="env-label">{{ env.toUpperCase() }} Token:</label>
            <div class="flex gap-2 flex-1">
              <input 
                type="password" 
                v-model="tokenInputs[env]" 
                :placeholder="`Enter ${env.toUpperCase()} active auth token...`" 
                class="crm-input flex-1"
              />
              <button @click="saveToken(env)" class="crm-btn crm-btn-primary">Save</button>
              <button @click="clearToken(env)" v-if="savedTokens[env]" class="crm-btn crm-btn-danger">Clear</button>
            </div>
          </div>
        </div>
      </details>
    </div>

    <div class="tabs-nav">
      <button 
        v-for="tab in tabs" 
        :key="tab.id" 
        @click="activeTab = tab.id" 
        class="tab-btn"
        :class="{ 'tab-active': activeTab === tab.id }"
        :disabled="isLoading"
      >
        {{ tab.label }}
      </button>
    </div>

    <div v-if="activeTab === 'single'" class="auditor-card">
      <h3 class="card-title mb-4">🗺️ Single Campaign Auditor</h3>
      <div class="inputs-grid">
        <div class="input-group">
          <label>📅 Scheduled Campaign URL</label>
          <input type="text" v-model="singleMainUrl" placeholder="https://drive.smartico.ai/..." class="crm-input" :disabled="isLoading" />
        </div>
        <div class="input-group">
          <label>🎯 Journey / Pop-up Campaign URL</label>
          <input type="text" v-model="singlePopUrl" placeholder="https://drive.smartico.ai/..." class="crm-input" :disabled="isLoading" />
        </div>
      </div>
      <div class="settings-row mt-4">
        <label class="checkbox-label">
          <input type="checkbox" v-model="useStats" :disabled="isLoading" />
          <span>📈 Collect Flow Map Statistics (Live View)</span>
        </label>
        <div class="days-input" v-if="useStats">
          <label>Days back:</label>
          <input type="number" v-model="daysBack" min="1" max="90" class="crm-input max-w-[80px]" :disabled="isLoading" />
        </div>
      </div>
      <button @click="triggerSingleAudit" class="crm-btn crm-btn-success run-btn mt-5" :disabled="isLoading || (!singleMainUrl && !singlePopUrl)">
        {{ isLoading ? 'Processing...' : '🚀 Execute Single Audit' }}
      </button>
    </div>

    <div v-if="activeTab === 'mass'" class="auditor-card">
      <h3 class="card-title mb-4">🕵️‍♂️ Bulk Campaign Auditor</h3>
      <div class="input-group">
        <label>🔗 Paste Smartico Campaign Links (One URL per line)</label>
        <textarea v-model="massUrlsInput" rows="6" placeholder="https://drive.smartico.ai/2828#/j_audience_scheduled/11111&#10;https://drive.smartico.ai/2828#/j_audience_head/22222" class="crm-textarea" :disabled="isLoading"></textarea>
      </div>
      <div class="settings-row mt-4">
        <label class="checkbox-label">
          <input type="checkbox" v-model="useStats" :disabled="isLoading" />
          <span>📈 Collect Flow Map Statistics (Live View)</span>
        </label>
        <div class="days-input" v-if="useStats">
          <label>Days back:</label>
          <input type="number" v-model="daysBack" min="1" max="90" class="crm-input max-w-[80px]" :disabled="isLoading" />
        </div>
      </div>
      <button @click="triggerMassAudit" class="crm-btn crm-btn-success run-btn mt-5" :disabled="isLoading || !massUrlsInput.trim()">
        {{ isLoading ? 'Processing Bulk List...' : '🚀 Execute Bulk Audit' }}
      </button>
    </div>

    <div v-if="activeTab === 'brands'" class="auditor-card">
      <div class="sub-tabs-nav mb-4">
        <button v-for="st in subTabs" :key="st.id" @click="activeSubTab = st.id" class="sub-tab-btn" :class="{ 'sub-active': activeSubTab === st.id }" :disabled="isLoading">
          {{ st.label }}
        </button>
      </div>

      <div v-if="activeSubTab === 'search'" class="space-y-4">
        <div class="input-group">
          <label>🔗 Target Campaign Links (One URL per line)</label>
          <textarea v-model="brandSearchUrls" rows="4" class="crm-textarea" placeholder="Urls to scan..."></textarea>
        </div>
        <div class="input-group">
          <label>🔍 Brand Name / Keyword</label>
          <input type="text" v-model="brandSearchKeyword" placeholder="e.g. Spinstein" class="crm-input" />
        </div>
        <button @click="executeBrandSearch" class="crm-btn crm-btn-primary w-full" :disabled="isLoading || !brandSearchKeyword || !brandSearchUrls">Scan Campaigns</button>
      </div>

      <div v-if="activeSubTab === 'labels'" class="space-y-4">
        <div class="grid grid-cols-3 gap-4">
          <div class="input-group">
            <label>Environment</label>
            <select v-model="labelEnv" class="crm-input">
              <option value="env2">ENV 2 (Production)</option>
              <option value="env5">ENV 5</option>
              <option value="env7">ENV 7</option>
            </select>
          </div>
          <div class="input-group">
            <label>Brand ID</label>
            <input type="text" v-model="labelBrandId" placeholder="e.g. 2828" class="crm-input" />
          </div>
          <div class="input-group">
            <label>Variation Criteria / Keyword</label>
            <input type="text" v-model="labelKeyword" placeholder="e.g. Spinstein" class="crm-input" />
          </div>
        </div>
        <div class="input-group">
          <label>📋 Paste Labels List</label>
          <textarea v-model="labelNamesInput" rows="4" class="crm-textarea" placeholder="crm2_brand_link&#10;{{label.bonus_label}}"></textarea>
        </div>
        <button @click="executeBulkLabels" class="crm-btn crm-btn-primary w-full" :disabled="isLoading || !labelKeyword || !labelNamesInput">Extract Dictionary Values</button>
      </div>

      <div v-if="activeSubTab === 'links'" class="space-y-4">
        <div class="input-group">
          <label>🔗 Tracking Short Links (One per line)</label>
          <textarea v-model="shortLinksInput" rows="4" class="crm-textarea" placeholder="rngsp.cc/xyz&#10;https://rebrand.ly/abc"></textarea>
        </div>
        <button @click="executeResolveLinks" class="crm-btn crm-btn-primary w-full" :disabled="isLoading || !shortLinksInput">Resolve Tracking Chains</button>
      </div>
    </div>

    <div class="auditor-card terminal-card" v-if="isLoading || logs.length > 0">
      <div class="progress-wrapper">
        <div class="progress-bar" :style="{ width: progress + '%' }"></div>
      </div>
      <div class="progress-text">{{ progress }}%</div>
      <div class="terminal" ref="terminalRef">
        <div v-for="(log, idx) in logs" :key="idx" class="terminal-line" v-html="log"></div>
      </div>
    </div>

    <div class="auditor-card results-table-card" v-if="tableResults && !isLoading">
      <h4 class="text-md font-bold mb-3 text-slate-700">📊 Operation Execution Output</h4>
      
      <div v-if="activeSubTab === 'search' && activeTab === 'brands'" class="space-y-4">
        <div v-for="(res, idx) in tableResults" :key="idx" class="border border-slate-200 rounded-lg p-4 bg-slate-50">
          <div class="flex justify-between font-bold text-slate-800 text-sm border-b pb-2">
            <span>📋 {{ res.name }} (ID: {{ res.campaign_id }})</span>
            <span :class="res.matches.length ? 'text-amber-600' : 'text-slate-400'">
              Matches: {{ res.matches.length }}
            </span>
          </div>
          <div class="text-xs font-mono text-slate-600 mt-2 space-y-1" v-if="res.matches.length">
            <div v-for="(m, mIdx) in res.matches" :key="mIdx" class="bg-white p-2 rounded border border-slate-100">
              <b class="text-blue-600">Path:</b> {{ m.path }} <br/> <b class="text-amber-600">Value:</b> {{ m.value }}
            </div>
          </div>
          <div v-else class="text-xs italic text-slate-400 mt-2">No matching structural brand rules configured.</div>
        </div>
      </div>

      <table v-if="['labels', 'links'].includes(activeSubTab) && activeTab === 'brands'" class="results-grid">
        <thead>
          <tr>
            <th>Input Token / Key</th>
            <th>Resolved Output Target Data Payload</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(val, key) in tableResults" :key="key">
            <td class="font-bold font-mono text-xs max-w-[250px] break-all">{{ key }}</td>
            <td class="font-mono text-xs break-all text-slate-700">{{ val }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="auditor-card result-card" v-if="finalHtml && !isLoading">
      <div class="result-content">
        <div class="result-icon">🎉</div>
        <div class="result-text">
          <h3>HTML Analysis Matrix Document Rendered Successfully</h3>
          <p>Interactive graph structures, deep text compliance checks, and cross-channel evaluations are ready.</p>
        </div>
        <button @click="downloadHtml" class="crm-btn crm-btn-primary download-btn">📥 Download HTML Report</button>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue';

// Configuration definitions
const tabs = [
  { id: 'single', label: '🗺️ Single Audit' },
  { id: 'mass', label: '🕵️‍♂️ Mass Audit' },
  { id: 'brands', label: '🏷️ Brands Tools' }
];

const subTabs = [
  { id: 'search', label: '🔍 Campaign Scan' },
  { id: 'labels', label: '🔠 Dictionary Extractor' },
  { id: 'links', label: '🔗 Redirect Chain Resolver' }
];

// Operational environment state tracking
const activeTab = ref('single');
const activeSubTab = ref('search');
const savedTokens = ref({ env2: '', env5: '', env7: '' });
const tokenInputs = ref({ env2: '', env5: '', env7: '' });

// Forms inputs data binding layers
const singleMainUrl = ref('');
const singlePopUrl = ref('');
const massUrlsInput = ref('');
const useStats = ref(true);
const daysBack = ref(14);

// Brand contextual tools forms binding
const brandSearchUrls = ref('');
const brandSearchKeyword = ref('');
const labelEnv = ref('env2');
const labelBrandId = ref('2828');
const labelKeyword = ref('');
const labelNamesInput = ref('');
const shortLinksInput = ref('');

// Execution logs state engine bindings
const isLoading = ref(false);
const progress = ref(0);
const logs = ref([]);
const finalHtml = ref('');
const tableResults = ref(null);
const terminalRef = ref(null);

const hasAnyToken = computed(() => Object.values(savedTokens.value).some(t => !!t));

onMounted(() => {
  ['env2', 'env5', 'env7'].forEach(env => {
    const t = localStorage.getItem(`smartico_token_${env}`);
    if (t) {
      savedTokens.value[env] = t;
      tokenInputs.value[env] = t;
    }
  });
});

function saveToken(env) {
  if (tokenInputs.value[env].trim()) {
    savedTokens.value[env] = tokenInputs.value[env].trim();
    localStorage.setItem(`smartico_token_${env}`, savedTokens.value[env]);
  }
}

function clearToken(env) {
  savedTokens.value[env] = '';
  tokenInputs.value[env] = '';
  localStorage.removeItem(`smartico_token_${env}`);
}

function extractEnvFromUrl(url) {
  if (!url) return 'env2';
  if (url.includes('drive-7') || url.includes('drive7')) return 'env7';
  if (url.includes('drive-5') || url.includes('drive5')) return 'env5';
  return 'env2';
}

watch(logs, async () => {
  await nextTick();
  if (terminalRef.value) terminalRef.value.scrollTop = terminalRef.value.scrollHeight;
}, { deep: true });

// Core stream-oriented executor engine pointing directly to local Node.js proxy routers
async function executeAuditPipeline(urlList) {
  isLoading.value = true;
  progress.value = 0;
  logs.value = [];
  finalHtml.value = '';
  tableResults.value = null;

  // Resolve matching environment credentials key based on the primary targeted link
  const targetEnv = extractEnvFromUrl(urlList[0]);
  const activeToken = savedTokens.value[targetEnv];

  if (!activeToken) {
    logs.value.push(`<span class="log-err">>> ❌ Missing authentication keys for targeted framework space ${targetEnv.toUpperCase()}</span>`);
    isLoading.value = false;
    return;
  }

  try {
    const response = await fetch('/api/auditor/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: urlList,
        token: activeToken,
        use_stats: useStats.value,
        days_back: daysBack.value
      })
    });

    if (!response.ok) throw new Error(`Gateway response runtime assertion failure: HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const rawPayload = line.replace('data: ', '').trim();
          if (!rawPayload) continue;

          try {
            const parsed = JSON.parse(rawPayload);
            if (parsed.type === 'progress') {
              logs.value.push(`<span class="log-time">>></span> ${parsed.msg}`);
              progress.value = parsed.percent;
            } else if (parsed.type === 'done') {
              finalHtml.value = parsed.html;
              progress.value = 100;
              logs.value.push(`<span class="log-success">>> ✅ Document composition finalized successfully. Output operational.</span>`);
              isLoading.value = false;
            } else if (parsed.type === 'error') {
              logs.value.push(`<span class="log-err">>> ❌ Remote execution exception: ${parsed.msg}</span>`);
              isLoading.value = false;
            }
          } catch (e) {
            console.error("Payload chunk serialization error parsing strategy handler:", e);
          }
        }
      }
    }
  } catch (err) {
    logs.value.push(`<span class="log-err">>> ❌ System transport level interface exception error: ${err.message}</span>`);
    isLoading.value = false;
  }
}

function triggerSingleAudit() {
  const targets = [];
  if (singleMainUrl.value.trim()) targets.push(singleMainUrl.value.trim());
  if (singlePopUrl.value.trim()) targets.push(singlePopUrl.value.trim());
  if (targets.length) executeAuditPipeline(targets);
}

function triggerMassAudit() {
  const targets = massUrlsInput.value.split('\n').map(u => u.trim()).filter(u => !!u);
  if (targets.length) executeAuditPipeline(targets);
}

// Brand scanning JSON-based transactional endpoint interactions
async function executeBrandSearch() {
  isLoading.value = true;
  tableResults.value = null;
  const urls = brandSearchUrls.value.split('\n').map(u => u.trim()).filter(u => !!u);
  const token = savedTokens.value[extractEnvFromUrl(urls[0])];

  try {
    const res = await fetch('/api/auditor/search-campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, keyword: brandSearchKeyword.value, token })
    });
    const data = await res.json();
    tableResults.value = data.results;
  } catch (e) {
    alert(`Execution failure: ${e.message}`);
  } finally {
    isLoading.value = false;
  }
}

async function executeBulkLabels() {
  isLoading.value = true;
  tableResults.value = null;
  const labels = labelNamesInput.value.split('\n').map(l => l.trim()).filter(l => !!l);
  const token = savedTokens.value[labelEnv.value];
  const boapi_host = labelEnv.value === 'env7' ? 'boapi7.smartico.ai' : (labelEnv.value === 'env5' ? 'boapi5.smartico.ai' : 'boapi.smartico.ai');

  try {
    const res = await fetch('/api/auditor/bulk-labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels, keyword: labelKeyword.value, brand_id: labelBrandId.value, boapi_host, token })
    });
    const data = await res.json();
    tableResults.value = data.results;
  } catch (e) {
    alert(`Execution failure: ${e.message}`);
  } finally {
    isLoading.value = false;
  }
}

async function executeResolveLinks() {
  isLoading.value = true;
  tableResults.value = null;
  const links = shortLinksInput.value.split('\n').map(l => l.trim()).filter(l => !!l);

  try {
    const res = await fetch('/api/auditor/resolve-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links })
    });
    const data = await res.json();
    tableResults.value = data.resolved;
  } catch (e) {
    alert(`Execution failure: ${e.message}`);
  } finally {
    isLoading.value = false;
  }
}

function downloadHtml() {
  if (!finalHtml.value) return;
  const blob = new Blob([finalHtml.value], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Smartico_Unified_Audit_Report_${new Date().getTime()}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<style scoped>
/* =====================================================================
   ☀️ LIGHT MODE DEFAULT STYLES
   ===================================================================== */
.auditor-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 1000px;
  margin: 0 auto;
  font-family: system-ui, sans-serif;
}

.auditor-card {
  background: #ffffff !important;
  border: 1px solid #e2e8f0 !important;
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
  transition: all 0.2s ease;
}

/* Force dark text contrast inside white cards to override global dark leaking */
.card-title, 
summary span, 
.env-label, 
.checkbox-label span, 
.days-input label {
  color: #0f172a !important; 
}

.input-group label {
  color: #475569 !important;
}

.disabled-card {
  opacity: 0.5;
  pointer-events: none;
  filter: grayscale(50%);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 12px;
}

.status-pill {
  font-size: 11px;
  font-weight: bold;
  padding: 2px 8px;
  border-radius: 10px;
}
.pill-green { background: #dcfce7 !important; color: #166534 !important; }
.pill-red { background: #fee2e2 !important; color: #991b1b !important; }

.token-inputs-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.token-row { display: flex; align-items: center; gap: 12px; }

.tabs-nav { display: flex; gap: 8px; border-bottom: 2px solid #e2e8f0; padding-bottom: 2px; }
.tab-btn {
  padding: 10px 20px;
  font-weight: 600;
  font-size: 14px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: #64748b;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  transition: all 0.2s;
}
.tab-btn:hover:not(:disabled) { color: #0f172a; }
.tab-active { color: #3b82f6 !important; border-bottom-color: #3b82f6 !important; }

.sub-tabs-nav { display: flex; gap: 6px; background: #f1f5f9; padding: 4px; border-radius: 8px; }
.sub-tab-btn { flex: 1; padding: 8px; font-size: 12px; font-weight: 600; border: none; background: transparent; border-radius: 6px; cursor: pointer; color: #475569; }
.sub-active { background: #ffffff !important; color: #0f172a !important; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }

.inputs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 640px) { .inputs-grid { grid-template-columns: 1fr; } }

.crm-input, .crm-textarea {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid #e2e8f0 !important;
  border-radius: 8px;
  font-size: 14px;
  outline: none;
  background: #f8fafc !important;
  color: #0f172a !important;
  box-sizing: border-box;
}
.crm-textarea { resize: vertical; font-family: monospace; font-size: 13px; }
.crm-input:focus, .crm-textarea:focus { border-color: #3b82f6 !important; background: #ffffff !important; }

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #f1f5f9;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
}
.checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
.days-input { display: flex; align-items: center; gap: 8px; font-size: 13px; }

.crm-btn { padding: 10px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid transparent; transition: all 0.2s; }
.crm-btn-primary { background: #3b82f6; color: white; }
.crm-btn-primary:hover { background: #2563eb; }
.crm-btn-danger { background: #fee2e2; color: #b91c1c; border-color: #fca5a5; }
.crm-btn-danger:hover { background: #fca5a5; }
.crm-btn-success { background: #10b981; color: white; }
.crm-btn-success:hover { background: #059669; }
.run-btn { width: 100%; padding: 14px; font-size: 15px; }

/* Terminal Layout Configuration */
.terminal-card { background: #0f172a !important; border-color: #1e293b !important; }
.progress-wrapper { width: 100%; height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden; }
.progress-bar { height: 100%; background: linear-gradient(90deg, #3b82f6, #10b981); transition: width 0.3s; }
.progress-text { color: #94a3b8 !important; font-size: 11px; text-align: right; margin-top: 4px; font-family: monospace; }
.terminal { background: #020617; border: 1px solid #1e293b; border-radius: 8px; padding: 14px; height: 220px; overflow-y: auto; font-family: monospace; font-size: 12px; line-height: 1.5; margin-top: 10px; color: #e2e8f0; }
.terminal-line { margin-bottom: 4px; }
:deep(.log-time) { color: #64748b; }
:deep(.log-success) { color: #10b981; font-weight: bold; }
:deep(.log-err) { color: #ef4444; font-weight: bold; }

.results-table-card { border-left: 4px solid #3b82f6; }
.results-grid { width: 100%; border-collapse: collapse; margin-top: 10px; }
.results-grid th { background: #f1f5f9; color: #475569; font-weight: 600; font-size: 12px; text-transform: uppercase; padding: 10px; border: 1px solid #e2e8f0; }
.results-grid td { padding: 10px; border: 1px solid #e2e8f0; background: #ffffff; color: #0f172a; }

.result-card { background: #f0fdf4 !important; border-color: #bbf7d0 !important; }
.result-content { display: flex; align-items: center; gap: 16px; }
.result-icon { font-size: 28px; }
.result-text h3 { margin: 0 0 2px 0; color: #166534 !important; font-size: 16px; font-weight: 700; }
.result-text p { margin: 0; color: #15803d !important; font-size: 13px; }
.download-btn { margin-left: auto; background: #15803d; color: white; }
.download-btn:hover { background: #166534; }


/* =====================================================================
   🌙 DARK MODE ENFORCEMENT OVERRIDES (Nuxt global cascade compatibility)
   ===================================================================== */
:global(.dark) .auditor-card {
  background: #1e293b !important;
  border-color: #334155 !important;
  box-shadow: none;
}

:global(.dark) .card-title, 
:global(.dark) summary span, 
:global(.dark) .env-label, 
:global(.dark) .checkbox-label span, 
:global(.dark) .days-input label {
  color: #f8fafc !important;
}

:global(.dark) .input-group label {
  color: #94a3b8 !important;
}

:global(.dark) .card-header,
:global(.dark) .tabs-nav {
  border-color: #334155 !important;
}

:global(.dark) .tab-btn:hover:not(:disabled) {
  color: #f8fafc;
}

:global(.dark) .sub-tabs-nav {
  background: #0f172a;
}

:global(.dark) .sub-tab-btn {
  color: #94a3b8;
}

:global(.dark) .sub-active {
  background: #1e293b !important;
  color: #f8fafc !important;
}

:global(.dark) .crm-input, 
:global(.dark) .crm-textarea {
  background: #0f172a !important;
  border-color: #334155 !important;
  color: #f1f5f9 !important;
}

:global(.dark) .settings-row {
  background: #0f172a;
  border-color: #334155;
}

:global(.dark) .results-grid th {
  background: #0f172a;
  color: #94a3b8;
  border-color: #334155;
}

:global(.dark) .results-grid td {
  background: #1e293b;
  color: #e2e8f0;
  border-color: #334155;
}
</style>