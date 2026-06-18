<template>
  <div class="auditor-panel">
    
    <div class="auditor-card top-auth-bar">
      <div class="auth-bar-left">
        <span class="card-icon" style="font-size: 20px;">🔑</span>
        <span class="token-title" style="margin: 0; font-size: 15px;">Smartico Tokens</span>
        <span class="status-pill" :class="hasAnyToken ? 'pill-green' : 'pill-red'" style="margin-left: 8px;">
          {{ hasAnyToken ? 'Configured' : 'No Tokens' }}
        </span>
      </div>
      
      <div class="auth-bar-right">
        <div v-for="env in ['env2', 'env5', 'env7']" :key="env" class="auth-env-group">
          <span class="env-badge">{{ env.toUpperCase() }}</span>
          <div style="display: flex;">
            <input 
              type="password" 
              v-model="tokenInputs[env]" 
              placeholder="Token..." 
              class="crm-input compact-input"
              style="border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: 0;"
              :disabled="isLoading"
            />
            <button @click="saveToken(env)" class="crm-btn crm-btn-primary compact-btn" :style="!savedTokens[env] ? 'border-top-left-radius: 0; border-bottom-left-radius: 0;' : 'border-radius: 0;'">Save</button>
            <button @click="clearToken(env)" v-if="savedTokens[env]" class="crm-btn crm-btn-danger compact-btn" style="border-top-left-radius: 0; border-bottom-left-radius: 0;">✕</button>
          </div>
        </div>
      </div>
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
        <textarea v-model="massUrlsInput" rows="6" placeholder="https://drive.smartico.ai/2828#/j_audience_scheduled/11111" class="crm-textarea" :disabled="isLoading"></textarea>
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

      <div v-if="activeSubTab === 'search'" style="display:flex; flex-direction:column; gap:16px;">
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

      <div v-if="activeSubTab === 'labels'" style="display:flex; flex-direction:column; gap:16px;">
        <div class="inputs-grid">
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
          <textarea v-model="labelNamesInput" rows="4" class="crm-textarea" placeholder="crm2_brand_link..."></textarea>
        </div>
        <button @click="executeBulkLabels" class="crm-btn crm-btn-primary w-full" :disabled="isLoading || !labelKeyword || !labelNamesInput">Extract Dictionary Values</button>
      </div>

      <div v-if="activeSubTab === 'links'" style="display:flex; flex-direction:column; gap:16px;">
        <div class="input-group">
          <label>🔗 Tracking Short Links (One per line)</label>
          <textarea v-model="shortLinksInput" rows="4" class="crm-textarea" placeholder="rngsp.cc/xyz..."></textarea>
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
      <h4 class="card-title mb-4">📊 Execution Output</h4>
      
      <div v-if="activeSubTab === 'search' && activeTab === 'brands'" style="display:flex; flex-direction:column; gap:16px;">
        <div v-for="(res, idx) in tableResults" :key="idx" class="table-results-nested">
          <div class="nested-header">
            <span>📋 {{ res.name }} (ID: {{ res.campaign_id }})</span>
            <span :class="res.matches.length ? 'match-success' : 'match-none'">
              Matches: {{ res.matches.length }}
            </span>
          </div>
          <div v-if="res.matches.length" style="margin-top: 10px; display:flex; flex-direction:column; gap:6px;">
            <div v-for="(m, mIdx) in res.matches" :key="mIdx" class="nested-row-match">
              <b style="color: #3b82f6;">Path:</b> {{ m.path }} <br/> 
              <b style="color: #10b981;">Value:</b> {{ m.value }}
            </div>
          </div>
          <div v-else class="match-none" style="margin-top: 10px; font-style: italic;">No matches found.</div>
        </div>
      </div>

      <div v-if="['labels', 'links'].includes(activeSubTab) && activeTab === 'brands'" style="overflow-x: auto; border-radius: 8px;">
        <table class="results-grid">
          <thead>
            <tr><th>Input Token / Key</th><th>Resolved Output Target Data Payload</th></tr>
          </thead>
          <tbody>
            <tr v-for="(val, key) in tableResults" :key="key">
              <td class="table-key-cell">{{ key }}</td>
              <td class="table-value-cell">{{ val }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="auditor-card result-card" v-if="finalHtml && !isLoading">
      <div class="result-content">
        <div class="result-icon">🎉</div>
        <div class="result-text">
          <h3>Report Rendered Successfully</h3>
          <p>Interactive graph structures and textual compliance checks are ready.</p>
        </div>
        <button @click="downloadHtml" class="crm-btn crm-btn-success download-btn">📥 Download Report</button>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue';

const tabs = [
  { id: 'single', label: '🗺️ Single Audit' },
  { id: 'mass', label: '🕵️‍♂️ Mass Audit' },
  { id: 'brands', label: '🏷️ Brands Tools' }
];

const subTabs = [
  { id: 'search', label: '🔍 Campaign Scan' },
  { id: 'labels', label: '🔠 Dictionary Extractor' },
  { id: 'links', label: '🔗 Redirect Resolver' }
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

  const titleMatch = finalHtml.value.match(/<title>Audit:\s*(.*?)<\/title>/i);
  
  if (titleMatch && titleMatch[1]) {
    let cleanName = titleMatch[1].replace(/[^a-zA-Z0-9\s\-_()а-яА-ЯёЁ]/gi, '').trim().replace(/\s+/g, '_');
    if (cleanName) {
      fileName = `${cleanName}_Report.html`;
    }
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
   🎨 BASE CSS (No Tailwind Required)
   ===================================================================== */
.auditor-panel { display: flex; flex-direction: column; gap: 20px; max-width: 1200px; margin: 0; font-family: system-ui, -apple-system, sans-serif; }
.auditor-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); width: 100%; box-sizing: border-box; }
.card-title { color: #0f172a; font-weight: bold; margin-top: 0; margin-bottom: 16px; font-size: 18px; }
.mb-4 { margin-bottom: 16px; }
.mt-4 { margin-top: 16px; }
.mt-5 { margin-top: 20px; }
.w-full { width: 100%; }

/* --- 🔑 Compact Top Auth Bar --- */
.top-auth-bar { padding: 12px 20px; margin-bottom: 4px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 16px; }
.auth-bar-left { display: flex; align-items: center; gap: 8px; }
.auth-bar-right { display: flex; flex-wrap: wrap; gap: 16px; flex: 1; justify-content: flex-end; }
.auth-env-group { display: flex; align-items: center; gap: 6px; }
.env-badge { font-size: 12px; font-weight: bold; color: #64748b; font-family: monospace; width: 40px; }
.compact-input { padding: 6px 10px !important; max-width: 120px; font-size: 12px !important; }
.compact-btn { padding: 6px 12px !important; font-size: 12px !important; }

/* Status Pills */
.status-pill { font-size: 10px; font-weight: bold; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; border: 1px solid transparent; }
.pill-green { background: #dcfce7; color: #166534; border-color: #86efac; }
.pill-red { background: #fee2e2; color: #991b1b; border-color: #fca5a5; }

/* --- 📑 Tabs --- */
.tabs-nav { display: flex; gap: 8px; border-bottom: 1px solid #e2e8f0; }
.tab-btn { padding: 12px 24px; font-weight: 600; font-size: 14px; border: none; background: transparent; cursor: pointer; color: #64748b; border-bottom: 2px solid transparent; transition: 0.2s; }
.tab-btn:hover:not(:disabled) { color: #0f172a; }
.tab-active { color: #3b82f6; border-bottom-color: #3b82f6; }

.sub-tabs-nav { display: flex; gap: 4px; background: #f8fafc; padding: 4px; border-radius: 8px; border: 1px solid #e2e8f0; }
.sub-tab-btn { flex: 1; padding: 8px; font-size: 12px; font-weight: 600; border: none; background: transparent; border-radius: 6px; cursor: pointer; color: #64748b; }
.sub-tab-btn:hover { color: #0f172a; }
.sub-active { background: #ffffff; color: #3b82f6; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }

/* --- 📝 Forms & Inputs --- */
.inputs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.input-group label { display: block; color: #475569; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
.crm-input, .crm-textarea { width: 100%; padding: 10px 14px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 14px; outline: none; background: #f8fafc; color: #0f172a; box-sizing: border-box; }
.crm-textarea { font-family: monospace; font-size: 13px; resize: vertical; }
.crm-input:focus, .crm-textarea:focus { border-color: #3b82f6; }
select.crm-input { appearance: none; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'></polyline></svg>"); background-repeat: no-repeat; background-position: right 10px center; background-size: 16px; padding-right: 35px; }

.settings-row { display: flex; align-items: center; justify-content: space-between; background: #f8fafc; padding: 12px 16px; border-radius: 8px; border: 1px solid #e2e8f0; }
.checkbox-label { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 500; cursor: pointer; color: #334155; }
.checkbox-label input[type="checkbox"] { accent-color: #3b82f6; width: 15px; height: 15px; }
.days-input { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #475569; }

/* --- 🔘 Buttons --- */
.crm-btn { border: none; font-weight: bold; cursor: pointer; transition: 0.2s; border-radius: 6px; }
.crm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.crm-btn-primary { background: #3b82f6; color: white; }
.crm-btn-primary:hover:not(:disabled) { background: #2563eb; }
.crm-btn-danger { background: #ef4444; color: white; }
.crm-btn-danger:hover:not(:disabled) { background: #dc2626; }
.crm-btn-success { background: #059669; color: white; padding: 14px; font-size: 15px; border-radius: 10px; width: 100%; }
.crm-btn-success:hover:not(:disabled) { background: #047857; }

/* --- 📺 Terminal --- */
.terminal-card { padding: 0 !important; overflow: hidden; background: #18181b !important; border-color: #27272a !important; }
.progress-wrapper { width: 100%; height: 6px; background: #27272a; }
.progress-bar { height: 100%; background: #3b82f6; transition: width 0.3s ease; }
.progress-text { padding: 8px 16px 0; color: #a1a1aa; font-size: 11px; text-align: right; font-family: monospace; }
.terminal { background: transparent; padding: 0 16px 16px; height: 220px; overflow-y: auto; font-family: monospace; font-size: 12px; line-height: 1.6; color: #e4e4e7; }
.terminal-line { margin-bottom: 4px; }
:deep(.log-time) { color: #71717a; }
:deep(.log-success) { color: #34d399; font-weight: bold; }
:deep(.log-err) { color: #f87171; font-weight: bold; }

/* --- 📊 Table Results --- */
.results-table-card { border-left: 4px solid #3b82f6; }
.table-results-nested { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
.nested-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; font-weight: bold; font-size: 14px; color: #0f172a; }
.match-success { background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 4px; font-size: 12px; border: 1px solid #86efac; }
.match-none { color: #64748b; font-size: 12px; }
.nested-row-match { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 4px; padding: 10px; font-family: monospace; font-size: 12px; color: #334155; }
.results-grid { width: 100%; border-collapse: collapse; }
.results-grid th { background: #f1f5f9; color: #475569; font-weight: 600; font-size: 12px; text-transform: uppercase; padding: 12px; border: 1px solid #e2e8f0; text-align: left; }
.results-grid td { padding: 12px; border: 1px solid #e2e8f0; font-family: monospace; font-size: 13px; color: #334155; }
.table-key-cell { font-weight: bold; max-width: 250px; word-break: break-all; }
.table-value-cell { word-break: break-all; }

/* --- 🎉 Result Card --- */
.result-card { background: #ecfdf5 !important; border-color: #a7f3d0 !important; display: flex; align-items: center; justify-content: space-between; }
.result-content { display: flex; align-items: center; gap: 16px; }
.result-icon { font-size: 32px; }
.result-text h3 { margin: 0 0 4px 0; color: #065f46; font-size: 16px; font-weight: bold; }
.result-text p { margin: 0; color: #047857; font-size: 13px; }
.download-btn { width: auto; padding: 10px 20px; font-size: 14px; margin: 0; }

/* =====================================================================
   🌙 DARK MODE (ZINC PALETTE) 
   ===================================================================== */
:global(.dark) .auditor-card { background: #18181b !important; border-color: #27272a !important; box-shadow: 0 4px 6px rgba(0,0,0,0.3) !important; }
:global(.dark) .card-title, :global(.dark) .token-title, :global(.dark) .env-label, 
:global(.dark) .checkbox-label span, :global(.dark) .days-input label { color: #f4f4f5 !important; }
:global(.dark) .input-group label { color: #a1a1aa !important; }

/* Dark mode overrides */
:global(.dark) .tabs-nav { border-color: #27272a !important; }
:global(.dark) .tab-btn:hover:not(:disabled) { color: #f4f4f5 !important; }
:global(.dark) .tab-active { color: #38bdf8 !important; border-bottom-color: #38bdf8 !important; }
:global(.dark) .sub-tabs-nav { background: #09090b !important; border-color: #27272a !important; }
:global(.dark) .sub-tab-btn { color: #71717a !important; }
:global(.dark) .sub-tab-btn:hover { color: #e4e4e7 !important; }
:global(.dark) .sub-active { background: #27272a !important; color: #38bdf8 !important; border-color: #27272a !important; box-shadow: none !important; }

:global(.dark) .crm-input, :global(.dark) .crm-textarea { background: #09090b !important; border-color: #27272a !important; color: #f4f4f5 !important; }
:global(.dark) .crm-input:focus, :global(.dark) .crm-textarea:focus { border-color: #38bdf8 !important; }
:global(.dark) .settings-row { background: #09090b !important; border-color: #27272a !important; }

/* Status Pills Dark */
:global(.dark) .pill-green { background: rgba(16, 185, 129, 0.1) !important; color: #34d399 !important; border-color: rgba(16, 185, 129, 0.2) !important; }
:global(.dark) .pill-red { background: rgba(239, 68, 68, 0.1) !important; color: #f87171 !important; border-color: rgba(239, 68, 68, 0.2) !important; }

/* Table Results Dark */
:global(.dark) .table-results-nested { border-color: #27272a !important; background: #09090b !important; }
:global(.dark) .nested-header { border-color: #27272a !important; color: #f4f4f5 !important; }
:global(.dark) .nested-row-match { background: #18181b !important; border-color: #27272a !important; color: #a1a1aa !important; }
:global(.dark) .match-success { background: rgba(16, 185, 129, 0.1) !important; color: #34d399 !important; border-color: rgba(16, 185, 129, 0.2) !important; }

:global(.dark) .results-grid th { background: #09090b !important; color: #a1a1aa !important; border-color: #27272a !important; }
:global(.dark) .results-grid td { background: #18181b !important; border-color: #27272a !important; color: #d4d4d8 !important; }

/* Result Card Dark */
:global(.dark) .result-card { background: rgba(6, 78, 59, 0.2) !important; border-color: rgba(4, 120, 87, 0.4) !important; }
:global(.dark) .result-text h3 { color: #34d399 !important; }
:global(.dark) .result-text p { color: #a7f3d0 !important; }
</style>