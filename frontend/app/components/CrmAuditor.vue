<template>
  <div class="auditor-panel">
    
    <!-- Left-aligned Token Management Card -->
    <div class="token-section-wrapper">
      <div class="auditor-card token-card">
        <div class="flex flex-col gap-4">
          <div class="flex items-center gap-3">
            <span class="card-icon">🔑</span>
            <span class="token-title">Smartico Auth Tokens Configuration</span>
            <span class="status-pill" :class="hasAnyToken ? 'pill-green' : 'pill-red'">
              {{ hasAnyToken ? 'Configured' : 'No tokens saved' }}
            </span>
          </div>
          
          <div class="token-inputs-grid">
            <div v-for="env in ['env2', 'env5', 'env7']" :key="env" class="token-row">
              <label class="env-label">{{ env.toUpperCase() }}:</label>
              <div class="flex gap-2 flex-1">
                <input 
                  type="password" 
                  v-model="tokenInputs[env]" 
                  :placeholder="`Enter ${env.toUpperCase()} active token...`" 
                  class="crm-input flex-1"
                />
                <button @click="saveToken(env)" class="crm-btn crm-btn-primary">Save</button>
                <button @click="clearToken(env)" v-if="savedTokens[env]" class="crm-btn crm-btn-danger">Clear</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Navigational component main tabs -->
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

    <!-- Single Campaign Module -->
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

    <!-- Bulk List Campaign Module -->
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

    <!-- Brand Toolsets Module -->
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

    <!-- Processing execution stream activity components -->
    <div class="auditor-card terminal-card" v-if="isLoading || logs.length > 0">
      <div class="progress-wrapper">
        <div class="progress-bar" :style="{ width: progress + '%' }"></div>
      </div>
      <div class="progress-text">{{ progress }}%</div>
      <div class="terminal" ref="terminalRef">
        <div v-for="(log, idx) in logs" :key="idx" class="terminal-line" v-html="log"></div>
      </div>
    </div>

    <!-- Tabular analysis grid structured output response mapping -->
    <div class="auditor-card results-table-card" v-if="tableResults && !isLoading">
      <h4 class="text-md font-bold mb-3 operation-output-title">📊 Operation Execution Output</h4>
      
      <div v-if="activeSubTab === 'search' && activeTab === 'brands'" class="space-y-4">
        <div v-for="(res, idx) in tableResults" :key="idx" class="table-results-nested border rounded-lg p-4">
          <div class="flex justify-between font-bold text-sm border-b pb-2 nested-header">
            <span>📋 {{ res.name }} (ID: {{ res.campaign_id }})</span>
            <span :class="res.matches.length ? 'text-violet-600 dark:text-violet-400' : 'text-slate-400'">
              Matches: {{ res.matches.length }}
            </span>
          </div>
          <div class="text-xs font-mono mt-2 space-y-1" v-if="res.matches.length">
            <div v-for="(m, mIdx) in res.matches" :key="mIdx" class="nested-row-match p-2 rounded border">
              <b class="text-violet-600 dark:text-violet-400">Path:</b> {{ m.path }} <br/> <b class="text-amber-600">Value:</b> {{ m.value }}
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
            <td class="font-bold font-mono text-xs max-w-[250px] break-all table-key-cell">{{ key }}</td>
            <td class="font-mono text-xs break-all table-value-cell">{{ val }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Finalized report presentation card -->
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
// Pure logical layer references remain intact exactly as provided.
import { ref, computed, onMounted, nextTick, watch } from 'vue';

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

const activeTab = ref('single');
const activeSubTab = ref('search');
const savedTokens = ref({ env2: '', env5: '', env7: '' });
const tokenInputs = ref({ env2: '', env5: '', env7: '' });

const singleMainUrl = ref('');
const singlePopUrl = ref('');
const massUrlsInput = ref('');
const useStats = ref(true);
const daysBack = ref(14);

const brandSearchUrls = ref('');
const brandSearchKeyword = ref('');
const labelEnv = ref('env2');
const labelBrandId = ref('2828');
const labelKeyword = ref('');
const labelNamesInput = ref('');
const shortLinksInput = ref('');

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

async function executeAuditPipeline(urlList) {
  isLoading.value = true;
  progress.value = 0;
  logs.value = [];
  finalHtml.value = '';
  tableResults.value = null;

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
    
    let streamBuffer = '';
    let reportIdToDownload = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      streamBuffer += decoder.decode(value, { stream: true });
      const lines = streamBuffer.split('\n');
      streamBuffer = lines.pop() || '';

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
              reportIdToDownload = parsed.report_id;
              break;
            } else if (parsed.type === 'error') {
              logs.value.push(`<span class="log-err">>> ❌ Remote execution exception: ${parsed.msg}</span>`);
              isLoading.value = false;
              return;
            }
          } catch (e) {
            console.error("Payload chunk serialization error parsing handler:", e);
          }
        }
      }
      if (reportIdToDownload) break;
    }

    if (reportIdToDownload) {
      try {
        logs.value.push(`<span class="log-time">>></span> Downloading full analysis matrix document safely...`);
        const fileResponse = await fetch(`/api/auditor/download/${reportIdToDownload}`);
        if (!fileResponse.ok) throw new Error("File transmission interface fault");
        
        finalHtml.value = await fileResponse.text();
        progress.value = 100;
        logs.value.push(`<span class="log-success">>> ✅ Document composition finalized successfully. Output operational.</span>`);
      } catch (downloadErr) {
        logs.value.push(`<span class="log-err">>> ❌ Failed to compile download response payload: ${downloadErr.message}</span>`);
      } finally {
        isLoading.value = false;
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

  let fileName = "Smartico_Audit_Report.html";

  
  if (activeTab.value === 'single') {
    
    const url = singleMainUrl.value || singlePopUrl.value || "";
    
    const match = url.match(/(?:scheduled|head)\/(\d+)/);
    const campId = match ? match[1] : "Unknown";
    fileName = `Campaign_${campId}_Report.html`;
  } else if (activeTab.value === 'mass') {
    
    const urlsCount = massUrlsInput.value.split('\n').map(u => u.trim()).filter(u => !!u).length;
    fileName = `Mass_Audit_${urlsCount}_Campaigns_Report.html`;
  }

  const blob = new Blob([finalHtml.value], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<style scoped>
/* =====================================================================
   ☀️ DYNAMIC ARCHITECTURE WITH PURPLE/VIOLET HIGHLIGHT ACCENTS
   ===================================================================== */
.auditor-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 1200px;
  margin: 0;
  font-family: system-ui, -apple-system, sans-serif;
}

.token-section-wrapper {
  display: flex;
  justify-content: flex-start;
  width: 100%;
}

/* Auditor Card - Fully dynamic light mode basis */
.auditor-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  width: 100%;
}

.token-card {
  max-width: 600px;
}

/* Static fallback contrast safe color overrides */
.card-title,
.token-title,
.env-label, 
.checkbox-label span, 
.days-input label,
.operation-output-title {
  color: #0f172a; 
  font-weight: 600;
}

.input-group label {
  color: #475569;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
  display: block;
}

.disabled-card {
  opacity: 0.4;
  pointer-events: none;
}

.status-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 9999px;
}
.pill-green { background: #dcfce7; color: #166534; border: 1px solid rgba(22, 101, 52, 0.1); }
.pill-red { background: #fee2e2; color: #991b1b; border: 1px solid rgba(153, 27, 27, 0.1); }

.token-inputs-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.token-row { display: flex; align-items: center; gap: 12px; }
.env-label { min-width: 60px; font-size: 12px; color: #64748b; }

/* Main Tabs - Purple accent implementation */
.tabs-nav { display: flex; gap: 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 0px; }
.tab-btn {
  padding: 12px 24px;
  font-weight: 600;
  font-size: 14px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: #64748b;
  border-bottom: 2px solid transparent;
  transition: all 0.15s ease;
}
.tab-btn:hover:not(:disabled) { color: #0f172a; }
.tab-active { color: #7c3aed !important; border-bottom-color: #7c3aed !important; }

/* Secondary Submodule navigation items */
.sub-tabs-nav { display: flex; gap: 4px; background: #f8fafc; padding: 4px; border-radius: 8px; border: 1px solid #e2e8f0; }
.sub-tab-btn { flex: 1; padding: 8px; font-size: 12px; font-weight: 600; border: none; background: transparent; border-radius: 6px; cursor: pointer; color: #64748b; transition: all 0.15s ease; }
.sub-tab-btn:hover { color: #0f172a; }
.sub-active { background: #ffffff; color: #7c3aed !important; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; }

.inputs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 768px) { .inputs-grid { grid-template-columns: 1fr; } }

/* Universal interactive form layout fields */
.crm-input, .crm-textarea {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 14px;
  outline: none;
  background: #f8fafc; 
  color: #0f172a;
  box-sizing: border-box;
  transition: border-color 0.15s ease;
}
.crm-textarea { resize: vertical; font-family: monospace; font-size: 13px; }
.crm-input:focus, .crm-textarea:focus { border-color: #a78bfa; }

select.crm-input {
  appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'></polyline></svg>");
  background-repeat: no-repeat;
  background-position: right 10px center;
  background-size: 16px;
  padding-right: 35px;
}

/* Parameter controls presentation grouping rows */
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #f8fafc;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
}
.checkbox-label { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 500; cursor: pointer; }
.checkbox-label input[type="checkbox"] {
  accent-color: #7c3aed;
  width: 15px;
  height: 15px;
}
.days-input { display: flex; align-items: center; gap: 8px; font-size: 13px; }

/* Control pipeline trigger configurations - Violet and Success colors split */
.crm-btn { padding: 10px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid transparent; transition: all 0.15s ease; }
.crm-btn-primary { background: #7c3aed; color: white; }
.crm-btn-primary:hover { background: #6d28d9; }
.crm-btn-danger { background: #fee2e2; color: #b91c1c; border-color: #fca5a5; }
.crm-btn-danger:hover { background: #fca5a5; }
.crm-btn-success { background: #059669; color: white; }
.crm-btn-success:hover { background: #047857; }
.run-btn { width: 100%; padding: 14px; font-size: 15px; border-radius: 10px; }
.crm-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Continuous active operations logging telemetry screen boxes */
.terminal-card { background: #09090b; border-color: #27272a; }
.progress-wrapper { width: 100%; height: 6px; background: #27272a; border-radius: 3px; overflow: hidden; }
.progress-bar { height: 100%; background: linear-gradient(90deg, #7c3aed, #059669); transition: width 0.3s ease; }
.progress-text { color: #71717a; font-size: 11px; text-align: right; margin-top: 4px; font-family: monospace; }
.terminal { background: #000000; border: 1px solid #27272a; border-radius: 8px; padding: 14px; height: 220px; overflow-y: auto; font-family: monospace; font-size: 12px; line-height: 1.6; margin-top: 10px; color: #e4e4e7; }
.terminal-line { margin-bottom: 4px; }
:deep(.log-time) { color: #3f3f46; }
:deep(.log-success) { color: #34d399; font-weight: bold; }
:deep(.log-err) { color: #f87171; font-weight: bold; }

/* Structural tabular grid components matching parameters styles */
.results-table-card { border-left: 4px solid #7c3aed; }
.table-results-nested { border-color: #e2e8f0; background: #f8fafc; }
.nested-header { border-color: #e2e8f0; color: #334155; }
.nested-row-match { background: #ffffff; border-color: #e2e8f0; color: #475569; }

.results-grid { width: 100%; border-collapse: collapse; margin-top: 10px; }
.results-grid th { background: #f8fafc; color: #475569; font-weight: 600; font-size: 11px; text-transform: uppercase; padding: 10px; border: 1px solid #e2e8f0; text-align: left; }
.results-grid td { padding: 12px 10px; border: 1px solid #e2e8f0; background: #ffffff; color: #334155; }
.table-key-cell { color: #0f172a; }
.table-value-cell { color: #334155; }

/* Downloader prompts layout metrics styling settings configurations */
.result-card { background: #f0fdf4; border-color: #bbf7d0; }
.result-content { display: flex; align-items: center; gap: 16px; }
.result-icon { font-size: 28px; }
.result-text h3 { margin: 0 0 2px 0; color: #166534; font-size: 16px; font-weight: 700; }
.result-text p { margin: 0; color: #15803d; font-size: 13px; opacity: 0.9; }
.download-btn { margin-left: auto; background: #15803d; color: white; border: none; }
.download-btn:hover { background: #166534; }


/* =====================================================================
   🌙 GLOBAL CASCADING DARK MODE SYSTEM MATRIX CONTEXT
   ===================================================================== */
:global(.dark) .auditor-card {
  background: #0f172a;
  border-color: #1e293b;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
}

:global(.dark) .card-title, 
:global(.dark) .token-title, 
:global(.dark) .env-label, 
:global(.dark) .checkbox-label span, 
:global(.dark) .days-input label,
:global(.dark) .operation-output-title {
  color: #f1f5f9;
}

:global(.dark) .input-group label {
  color: #94a3b8;
}

:global(.dark) .tabs-nav {
  border-color: #1e293b;
}

:global(.dark) .tab-btn:hover:not(:disabled) {
  color: #f1f5f9;
}
:global(.dark) .tab-active { 
  color: #a78bfa !important; 
  border-bottom-color: #a78bfa !important; 
}

:global(.dark) .sub-tabs-nav {
  background: #020617;
  border-color: #1e293b;
}
:global(.dark) .sub-tab-btn {
  color: #64748b;
}
:global(.dark) .sub-tab-btn:hover {
  color: #e2e8f0;
}
:global(.dark) .sub-active {
  background: #1e293b;
  color: #a78bfa !important;
  border-color: #1e293b;
}

:global(.dark) .crm-input, 
:global(.dark) .crm-textarea {
  background: #020617;
  border-color: #1e293b;
  color: #f1f5f9;
}
:global(.dark) .crm-input:focus, 
:global(.dark) .crm-textarea:focus { 
  border-color: #a78bfa; 
}

:global(.dark) .settings-row {
  background: #020617;
  border-color: #1e293b;
}

:global(.dark) .table-results-nested { 
  border-color: #1e293b; 
  background: #020617; 
}
:global(.dark) .nested-header { 
  border-color: #1e293b; 
  color: #f1f5f9; 
}
:global(.dark) .nested-row-match { 
  background: #0f172a; 
  border-color: #1e293b; 
  color: #94a3b8; 
}

:global(.dark) .results-grid th {
  background: #020617;
  color: #94a3b8;
  border-color: #1e293b;
}
:global(.dark) .results-grid td {
  background: #0f172a;
  border-color: #1e293b;
}
:global(.dark) .table-key-cell { color: #f1f5f9; }
:global(.dark) .table-value-cell { color: #cbd5e1; }

:global(.dark) .result-card {
  background: rgba(6, 78, 59, 0.2);
  border-color: rgba(4, 120, 87, 0.4);
}
:global(.dark) .result-text h3 { color: #34d399; }
:global(.dark) .result-text p { color: #a7f3d0; }
:global(.dark) .download-btn { background: #059669; }
:global(.dark) .download-btn:hover { background: #047857; }
</style>