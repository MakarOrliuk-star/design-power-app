<template>
  <div class="flex flex-col gap-6 max-w-[1200px] w-full font-sans">
    
    <!-- 🔑 COMPACT TOP AUTH BAR -->
    <div class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 shadow-sm w-full flex flex-col xl:flex-row xl:items-center justify-between gap-4 transition-colors">
      <div class="flex items-center gap-3 shrink-0">
        <span class="text-xl">🔑</span>
        <span class="font-bold text-zinc-900 dark:text-zinc-100">Smartico Tokens</span>
        <span :class="hasAnyToken ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/50' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800/50'" class="px-2.5 py-0.5 rounded-full text-[10px] font-bold border uppercase tracking-wider">
          {{ hasAnyToken ? 'Configured' : 'No Tokens' }}
        </span>
      </div>

      <div class="flex flex-wrap items-center gap-4 w-full xl:w-auto xl:justify-end">
        <div v-for="env in ['env2', 'env5', 'env7']" :key="env" class="flex items-center gap-2">
          <span class="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase w-8">{{ env }}</span>
          <div class="flex">
            <input 
              type="password" 
              v-model="tokenInputs[env]" 
              placeholder="Token..." 
              class="w-28 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-l-md px-3 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors" 
              :disabled="isLoading"
            />
            <button @click="saveToken(env)" class="bg-zinc-800 hover:bg-zinc-700 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-white px-3 py-1.5 text-xs font-semibold transition-colors border border-transparent" :class="!savedTokens[env] ? 'rounded-r-md' : ''">Save</button>
            <button @click="clearToken(env)" v-if="savedTokens[env]" class="bg-red-500 hover:bg-red-600 text-white px-3 py-1.5 rounded-r-md text-xs font-bold transition-colors border border-transparent">✕</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 📑 TABS NAVIGATION -->
    <div class="flex gap-2 border-b border-zinc-200 dark:border-zinc-800 pb-0">
      <button 
        v-for="tab in tabs" 
        :key="tab.id" 
        @click="activeTab = tab.id" 
        class="px-5 py-3 font-semibold text-sm transition-colors border-b-2 focus:outline-none"
        :class="activeTab === tab.id ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'"
        :disabled="isLoading"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- 🗺️ SINGLE CAMPAIGN MODULE -->
    <div v-if="activeTab === 'single'" class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-6 shadow-sm w-full transition-colors">
      <h3 class="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-5">🗺️ Single Campaign Auditor</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div>
          <label class="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">📅 Scheduled Campaign URL</label>
          <input type="text" v-model="singleMainUrl" placeholder="https://drive.smartico.ai/..." class="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors" :disabled="isLoading" />
        </div>
        <div>
          <label class="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">🎯 Journey / Pop-up Campaign URL</label>
          <input type="text" v-model="singlePopUrl" placeholder="https://drive.smartico.ai/..." class="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors" :disabled="isLoading" />
        </div>
      </div>
      
      <div class="flex items-center justify-between mt-5 bg-zinc-50 dark:bg-zinc-950 p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 transition-colors">
        <label class="flex items-center gap-2.5 cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" v-model="useStats" class="w-4 h-4 accent-blue-500 rounded border-zinc-300" :disabled="isLoading" />
          📈 Collect Flow Map Statistics (Live View)
        </label>
        <div class="flex items-center gap-2" v-if="useStats">
          <span class="text-xs font-medium text-zinc-500 dark:text-zinc-400">Days back:</span>
          <input type="number" v-model="daysBack" min="1" max="90" class="w-16 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 text-sm text-center text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors" :disabled="isLoading" />
        </div>
      </div>
      
      <button @click="triggerSingleAudit" class="w-full mt-6 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3.5 rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.99]" :disabled="isLoading || (!singleMainUrl && !singlePopUrl)">
        {{ isLoading ? 'Processing...' : '🚀 Execute Single Audit' }}
      </button>
    </div>

    <!-- 🕵️‍♂️ BULK CAMPAIGN MODULE -->
    <div v-if="activeTab === 'mass'" class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-6 shadow-sm w-full transition-colors">
      <h3 class="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-5">🕵️‍♂️ Bulk Campaign Auditor</h3>
      <div>
        <label class="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">🔗 Paste Smartico Campaign Links (One URL per line)</label>
        <textarea v-model="massUrlsInput" rows="6" placeholder="https://drive.smartico.ai/2828#/j_audience_scheduled/11111" class="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-3 text-sm font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors resize-y leading-relaxed" :disabled="isLoading"></textarea>
      </div>
      
      <div class="flex items-center justify-between mt-5 bg-zinc-50 dark:bg-zinc-950 p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 transition-colors">
        <label class="flex items-center gap-2.5 cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" v-model="useStats" class="w-4 h-4 accent-blue-500 rounded border-zinc-300" :disabled="isLoading" />
          📈 Collect Flow Map Statistics (Live View)
        </label>
        <div class="flex items-center gap-2" v-if="useStats">
          <span class="text-xs font-medium text-zinc-500 dark:text-zinc-400">Days back:</span>
          <input type="number" v-model="daysBack" min="1" max="90" class="w-16 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 text-sm text-center text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors" :disabled="isLoading" />
        </div>
      </div>
      
      <button @click="triggerMassAudit" class="w-full mt-6 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3.5 rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.99]" :disabled="isLoading || !massUrlsInput.trim()">
        {{ isLoading ? 'Processing Bulk List...' : '🚀 Execute Bulk Audit' }}
      </button>
    </div>

    <!-- 🏷️ BRANDS TOOLS MODULE -->
    <div v-if="activeTab === 'brands'" class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-6 shadow-sm w-full transition-colors">
      <div class="flex gap-1 bg-zinc-100 dark:bg-zinc-950 p-1 rounded-lg border border-zinc-200 dark:border-zinc-800 mb-6 transition-colors">
        <button v-for="st in subTabs" :key="st.id" @click="activeSubTab = st.id" 
          class="flex-1 py-2 text-xs font-bold rounded-md transition-colors" 
          :class="activeSubTab === st.id ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'" 
          :disabled="isLoading">
          {{ st.label }}
        </button>
      </div>

      <!-- Sub-Tab: Search -->
      <div v-if="activeSubTab === 'search'" class="flex flex-col gap-5">
        <div>
          <label class="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">🔗 Target Campaign Links (One URL per line)</label>
          <textarea v-model="brandSearchUrls" rows="4" class="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-3 text-sm font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors leading-relaxed" placeholder="Urls to scan..."></textarea>
        </div>
        <div>
          <label class="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">🔍 Brand Name / Keyword</label>
          <input type="text" v-model="brandSearchKeyword" placeholder="e.g. Spinstein" class="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors" />
        </div>
        <button @click="executeBrandSearch" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.99]" :disabled="isLoading || !brandSearchKeyword || !brandSearchUrls">Scan Campaigns</button>
      </div>

      <!-- Sub-Tab: Labels -->
      <div v-if="activeSubTab === 'labels'" class="flex flex-col gap-5">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div>
            <label class="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">Environment</label>
            <select v-model="labelEnv" class="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors appearance-none">
              <option value="env2">ENV 2 (Production)</option>
              <option value="env5">ENV 5</option>
              <option value="env7">ENV 7</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">Brand ID</label>
            <input type="text" v-model="labelBrandId" placeholder="e.g. 2828" class="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors" />
          </div>
          <div>
            <label class="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">Variation Criteria / Keyword</label>
            <input type="text" v-model="labelKeyword" placeholder="e.g. Spinstein" class="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors" />
          </div>
        </div>
        <div>
          <label class="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">📋 Paste Labels List</label>
          <textarea v-model="labelNamesInput" rows="4" class="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-3 text-sm font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors leading-relaxed" placeholder="crm2_brand_link..."></textarea>
        </div>
        <button @click="executeBulkLabels" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.99]" :disabled="isLoading || !labelKeyword || !labelNamesInput">Extract Dictionary Values</button>
      </div>

      <!-- Sub-Tab: Links -->
      <div v-if="activeSubTab === 'links'" class="flex flex-col gap-5">
        <div>
          <label class="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">🔗 Tracking Short Links (One per line)</label>
          <textarea v-model="shortLinksInput" rows="4" class="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-3 text-sm font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors leading-relaxed" placeholder="rngsp.cc/xyz..."></textarea>
        </div>
        <button @click="executeResolveLinks" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.99]" :disabled="isLoading || !shortLinksInput">Resolve Tracking Chains</button>
      </div>
    </div>

    <!-- 📺 TERMINAL OUTPUT -->
    <div class="bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden shadow-xl" v-if="isLoading || logs.length > 0">
      <div class="h-1.5 w-full bg-zinc-900">
        <div class="h-full bg-blue-500 transition-all duration-300" :style="{ width: progress + '%' }"></div>
      </div>
      <div class="flex justify-between items-center px-4 pt-3 pb-1 border-b border-zinc-800/50">
        <span class="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Execution Stream</span>
        <span class="text-xs font-mono text-zinc-400">{{ progress }}%</span>
      </div>
      <div class="p-4 text-xs font-mono text-zinc-300 h-64 overflow-y-auto leading-relaxed" ref="terminalRef">
        <div v-for="(log, idx) in logs" :key="idx" class="mb-1" v-html="log"></div>
      </div>
    </div>

    <!-- 📊 TABLE RESULTS (BRANDS TOOLS) -->
    <div class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-6 shadow-sm w-full transition-colors" v-if="tableResults && !isLoading">
      <h4 class="text-md font-bold mb-4 text-zinc-900 dark:text-zinc-100">📊 Execution Output</h4>
      
      <!-- Search Mode Results -->
      <div v-if="activeSubTab === 'search' && activeTab === 'brands'" class="flex flex-col gap-3">
        <div v-for="(res, idx) in tableResults" :key="idx" class="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 bg-zinc-50 dark:bg-zinc-950/50 transition-colors">
          <div class="flex justify-between items-center border-b border-zinc-200 dark:border-zinc-800 pb-2 mb-3">
            <span class="font-bold text-sm text-zinc-800 dark:text-zinc-200">📋 {{ res.name }} <span class="text-zinc-500 font-normal ml-1">(ID: {{ res.campaign_id }})</span></span>
            <span :class="res.matches.length ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/50' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700'" class="px-2 py-0.5 text-xs font-bold rounded-md border">
              Matches: {{ res.matches.length }}
            </span>
          </div>
          <div class="text-xs font-mono space-y-2" v-if="res.matches.length">
            <div v-for="(m, mIdx) in res.matches" :key="mIdx" class="bg-white dark:bg-zinc-900 p-3 rounded-md border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 leading-relaxed shadow-sm transition-colors">
              <span class="text-blue-600 dark:text-blue-400 font-bold mr-1">Path:</span> {{ m.path }} <br/> 
              <span class="text-emerald-600 dark:text-emerald-500 font-bold mr-1">Value:</span> {{ m.value }}
            </div>
          </div>
          <div v-else class="text-xs italic text-zinc-500 dark:text-zinc-400 mt-2">No matches found for the specified keyword.</div>
        </div>
      </div>

      <!-- Labels/Links Grid Results -->
      <div v-if="['labels', 'links'].includes(activeSubTab) && activeTab === 'brands'" class="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table class="w-full text-left border-collapse">
          <thead class="bg-zinc-100 dark:bg-zinc-950/50 text-xs uppercase text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th class="p-3 border-r border-zinc-200 dark:border-zinc-800 font-semibold tracking-wide">Input Token / Key</th>
              <th class="p-3 font-semibold tracking-wide">Resolved Output Target Data Payload</th>
            </tr>
          </thead>
          <tbody class="text-xs font-mono text-zinc-700 dark:text-zinc-300 divide-y divide-zinc-200 dark:divide-zinc-800">
            <tr v-for="(val, key) in tableResults" :key="key" class="bg-white dark:bg-zinc-900 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
              <td class="p-3 border-r border-zinc-200 dark:border-zinc-800 font-bold max-w-[250px] break-all text-zinc-900 dark:text-zinc-100">{{ key }}</td>
              <td class="p-3 break-all leading-relaxed">{{ val }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 🎉 DOWNLOAD READY PROMPT -->
    <div class="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 rounded-xl p-6 shadow-sm w-full flex flex-col md:flex-row md:items-center justify-between gap-5 transition-colors" v-if="finalHtml && !isLoading">
      <div class="flex items-center gap-4">
        <div class="text-4xl drop-shadow-sm">🎉</div>
        <div>
          <h3 class="text-emerald-800 dark:text-emerald-400 font-bold text-lg mb-1">Report Rendered Successfully</h3>
          <p class="text-emerald-600 dark:text-emerald-500/80 text-sm m-0">Interactive graph structures and textual compliance checks are ready.</p>
        </div>
      </div>
      <button @click="downloadHtml" class="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 px-6 rounded-lg shadow-sm transition-all active:scale-[0.98] whitespace-nowrap flex items-center justify-center gap-2">
        <span class="text-lg">📥</span> Download Report
      </button>
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
/* 
  Стили для инжектируемого HTML из бэкенда (терминал логов). 
  Всё остальное теперь на 100% контролируется утилитами Tailwind в шаблоне.
*/
:deep(.log-time) { color: #71717a; } /* zinc-500 */
:deep(.log-success) { color: #34d399; font-weight: 700; } /* emerald-400 */
:deep(.log-err) { color: #f87171; font-weight: 700; } /* red-400 */
</style>