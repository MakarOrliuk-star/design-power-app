<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

interface SmsNetwork {
  _uid?: number;
  mcc: string;
  mnc: string;
  country: string;
  countryName?: string;
  network: string;
  networkName?: string;
  providerName?: string;
}

interface SmsTemplate {
  id?: number;
  country: string;
  language: string;
  body: string;
  isDefault: boolean;
  mnc?: string | null;
}

interface SmsMessageItem {
  id: string;
  status: string;
  mcc: string;
  mnc: string;
  phoneNumber: string;
  senderId: string;
  messageBody?: string;
  latency?: number;
  errorLog?: string;
  sentAt?: string;
}

interface CampaignStats {
  total: number;
  sent: number;
  delivered: number;
  failed: number;
}

interface SmsCampaign {
  id: string;
  provider: string;
  status: string;
  stats: CampaignStats;
  createdAt: string;
  messages?: SmsMessageItem[];
}

// ==========================================
// STATE
// ==========================================
const activeTab = ref<'new' | 'history'>('new');
const currentStep = ref<1 | 2 | 3>(1);

// Step 1: Config
const loadingNetworks = ref(false);
const networks = ref<SmsNetwork[]>([]);
const selectedProvider = ref<'dm' | 'miatel' | 'fortytwo' | 'messagewhiz'>('dm');
const dmTokenKey = ref<string>('DM_TOKEN_1');
const senderId = ref<string>('Info');
const selectedCountries = ref<string[]>([]);
const selectedNetworkUids = ref<Set<number>>(new Set());

// Step 2: Language & Content
const loadingTemplates = ref(false);
const countryLanguageMap = ref<Record<string, string>>({});
const templatesMapping = ref<Record<string, SmsTemplate[]>>({});
const editingTemplate = ref<{ country: string; language: string; body: string } | null>(null);

// Step 3: Execution & Polling
const creatingBatch = ref(false);
const activeCampaignId = ref<string | null>(null);
const activeCampaign = ref<SmsCampaign | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

// History
const loadingHistory = ref(false);
const historyCampaigns = ref<SmsCampaign[]>([]);

// ==========================================
// COMPUTED (БЕЗ ИСПОЛЬЗОВАНИЯ ?.)
// ==========================================
const availableCountries = computed(() => {
  const map = new Map<string, string>();
  networks.value.forEach(n => {
    const cName = n.countryName || n.country;
    if (cName && !map.has(cName)) {
      map.set(cName, n.mcc);
    }
  });
  return Array.from(map.entries()).map(([name, mcc]) => ({ name, mcc })).sort((a, b) => a.name.localeCompare(b.name));
});

const filteredNetworks = computed(() => {
  if (selectedCountries.value.length === 0) return [];
  const allowedMccs = new Set(
    availableCountries.value.filter(c => selectedCountries.value.includes(c.name)).map(c => c.mcc)
  );
  return networks.value.filter(n => allowedMccs.has(n.mcc));
});

const isAllFilteredSelected = computed(() => {
  if (filteredNetworks.value.length === 0) return false;
  return filteredNetworks.value.every(n => n._uid !== undefined && selectedNetworkUids.value.has(n._uid));
});

const selectedNetworksList = computed(() => {
  return networks.value.filter(n => n._uid !== undefined && selectedNetworkUids.value.has(n._uid));
});

const activeTotal = computed(() => {
  return activeCampaign.value && activeCampaign.value.stats ? activeCampaign.value.stats.total : 0;
});

const activeSent = computed(() => {
  return activeCampaign.value && activeCampaign.value.stats ? activeCampaign.value.stats.sent : 0;
});

const activeDelivered = computed(() => {
  return activeCampaign.value && activeCampaign.value.stats ? activeCampaign.value.stats.delivered : 0;
});

const activeStatus = computed(() => {
  return activeCampaign.value ? activeCampaign.value.status : 'pending';
});

const activeMessagesList = computed(() => {
  return activeCampaign.value && activeCampaign.value.messages ? activeCampaign.value.messages : [];
});

const deliveryRate = computed(() => {
  if (!activeCampaign.value || !activeCampaign.value.stats || activeCampaign.value.stats.sent === 0) {
    return '0.0%';
  }
  const rate = (activeCampaign.value.stats.delivered / activeCampaign.value.stats.sent) * 100;
  return `${rate.toFixed(1)}%`;
});

// ==========================================
// METHODS
// ==========================================

function getTemplateBody(country: string, language?: string): string {
  const list = templatesMapping.value[country];
  if (!list || !Array.isArray(list)) return 'Marketing SMS Text';
  const targetLang = language || countryLanguageMap.value[country] || 'English';
  const item = list.find(t => t.language === targetLang);
  return item ? item.body : 'Marketing SMS Text';
}

async function fetchNetworks() {
  loadingNetworks.value = true;
  try {
    const res = await fetch('/api/sms/networks', { credentials: 'include' });
    const json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      networks.value = json.data.map((n: SmsNetwork, idx: number) => ({
        ...n,
        _uid: idx,
        country: n.countryName || n.country || 'Unknown',
        network: n.providerName || n.networkName || n.network || 'Unknown'
      }));
    }
  } catch (err) {
    console.error('Failed to load networks:', err);
  } finally {
    loadingNetworks.value = false;
  }
}

function selectAllCountries(status: boolean) {
  if (status) {
    selectedCountries.value = availableCountries.value.map(c => c.name);
  } else {
    selectedCountries.value = [];
  }
  updateSelectedNetworksFromFilter();
}

function toggleCountry(countryName: string) {
  const idx = selectedCountries.value.indexOf(countryName);
  if (idx > -1) {
    selectedCountries.value.splice(idx, 1);
  } else {
    selectedCountries.value.push(countryName);
  }
  updateSelectedNetworksFromFilter();
}

function updateSelectedNetworksFromFilter() {
  const newSet = new Set<number>();
  filteredNetworks.value.forEach(n => {
    if (n._uid !== undefined) newSet.add(n._uid);
  });
  selectedNetworkUids.value = newSet;
}

function toggleAllNetworks(status: boolean) {
  const newSet = new Set(selectedNetworkUids.value);
  filteredNetworks.value.forEach(n => {
    if (n._uid !== undefined) {
      if (status) newSet.add(n._uid);
      else newSet.delete(n._uid);
    }
  });
  selectedNetworkUids.value = newSet;
}

function toggleNetworkUid(uid?: number) {
  if (uid === undefined) return;
  const newSet = new Set(selectedNetworkUids.value);
  if (newSet.has(uid)) newSet.delete(uid);
  else newSet.add(uid);
  selectedNetworkUids.value = newSet;
}

async function proceedToStep2() {
  if (selectedNetworksList.value.length === 0) return;
  loadingTemplates.value = true;
  currentStep.value = 2;

  const uniqueSelectedCountries = [...new Set(selectedNetworksList.value.map(n => n.country))];

  try {
    const res = await fetch('/api/sms/templates/mapping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ countries: uniqueSelectedCountries }),
    });
    const json = await res.json();
    if (json.success && json.data) {
      templatesMapping.value = json.data;

      const newMap: Record<string, string> = {};
      uniqueSelectedCountries.forEach(c => {
        const tmpls = json.data[c] || [];
        const def = tmpls.find((t: SmsTemplate) => t.isDefault) || tmpls[0];
        newMap[c] = def ? def.language : 'English';
      });
      countryLanguageMap.value = newMap;
    }
  } catch (err) {
    console.error('Failed to load templates:', err);
  } finally {
    loadingTemplates.value = false;
  }
}

function openEditTemplateModal(country: string, currentLang?: string) {
  const lang = currentLang || countryLanguageMap.value[country] || 'English';
  const body = getTemplateBody(country, lang);
  
  editingTemplate.value = {
    country,
    language: lang,
    body,
  };
}

async function saveTemplateChanges() {
  if (!editingTemplate.value) return;
  try {
    const res = await fetch('/api/sms/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(editingTemplate.value),
    });
    const json = await res.json();
    if (json.success) {
      editingTemplate.value = null;
      proceedToStep2();
    }
  } catch (err) {
    console.error('Failed to save template:', err);
  }
}

async function startBatchProcess() {
  creatingBatch.value = true;

  const targets = selectedNetworksList.value.map(net => ({
    mcc: net.mcc,
    mnc: net.mnc,
    country: net.country,
    network: net.network,
    language: countryLanguageMap.value[net.country] || 'English',
  }));

  try {
    const res = await fetch('/api/sms/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        provider: selectedProvider.value,
        dmTokenKey: selectedProvider.value === 'dm' ? dmTokenKey.value : undefined,
        senderId: senderId.value || 'Info',
        targets,
      }),
    });
    const json = await res.json();
    if (json.success && json.campaignId) {
      activeCampaignId.value = json.campaignId;
      currentStep.value = 3;
      startPolling();
    } else {
      alert(json.error || 'Ошибка при создании кампании');
    }
  } catch (err) {
    console.error('Failed to start batch:', err);
  } finally {
    creatingBatch.value = false;
  }
}

function startPolling() {
  stopPolling();
  pollCampaignStatus();
  pollTimer = setInterval(pollCampaignStatus, 5000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollCampaignStatus() {
  if (!activeCampaignId.value) return;
  try {
    const res = await fetch(`/api/sms/campaign/${activeCampaignId.value}`, { credentials: 'include' });
    const json = await res.json();
    if (json.success && json.campaign) {
      activeCampaign.value = json.campaign;
      if (['completed', 'failed'].includes(json.campaign.status)) {
        stopPolling();
      }
    }
  } catch (err) {
    console.error('Polling error:', err);
  }
}

async function fetchHistory() {
  loadingHistory.value = true;
  try {
    const res = await fetch('/api/sms/history', { credentials: 'include' });
    const json = await res.json();
    if (json.success) {
      historyCampaigns.value = json.campaigns || [];
    }
  } catch (err) {
    console.error('History fetch error:', err);
  } finally {
    loadingHistory.value = false;
  }
}

function switchTab(tab: 'new' | 'history') {
  activeTab.value = tab;
  if (tab === 'history') {
    fetchHistory();
  }
}

function resetToStep1() {
  stopPolling();
  activeCampaignId.value = null;
  activeCampaign.value = null;
  currentStep.value = 1;
}

function getStatusBadgeClass(status: string) {
  switch (status) {
    case 'RECEIVED':
    case 'POSITIVE':
    case 'completed':
      return 'pill-green';
    case 'EXPIRED':
    case 'ERROR':
    case 'failed':
      return 'pill-red';
    case 'SENT':
    case 'processing':
      return 'pill-blue';
    default:
      return 'pill-yellow';
  }
}

onMounted(() => {
  fetchNetworks();
});

onUnmounted(() => {
  stopPolling();
});
</script>

<template>
  <div class="sms-panel">
    <!-- Header Controls -->
    <div class="sms-card header-card">
      <div class="header-title-row">
        <div class="title-meta">
          <span class="service-icon">📱</span>
          <div>
            <h2 class="card-title">СМС-Плейсмент Тестер</h2>
            <p class="subtitle">Массовая проверка доставки СМС по каналам операторов через TelQ</p>
          </div>
        </div>
        <div class="sub-tabs-nav">
          <button 
            class="sub-tab-btn" 
            :class="{ 'sub-active': activeTab === 'new' }"
            @click="switchTab('new')"
          >
            🚀 Новый запуск
          </button>
          <button 
            class="sub-tab-btn" 
            :class="{ 'sub-active': activeTab === 'history' }"
            @click="switchTab('history')"
          >
            📊 История отправок
          </button>
        </div>
      </div>
    </div>

    <!-- TAB 1: NEW BATCH -->
    <div v-if="activeTab === 'new'">
      <!-- Stepper Nav -->
      <div class="stepper-nav">
        <div class="step-item" :class="{ active: currentStep === 1, completed: currentStep > 1 }">
          <div class="step-num">1</div>
          <span>Конфигурация сетей</span>
        </div>
        <div class="step-line"></div>
        <div class="step-item" :class="{ active: currentStep === 2, completed: currentStep > 2 }">
          <div class="step-num">2</div>
          <span>Языки и контент</span>
        </div>
        <div class="step-line"></div>
        <div class="step-item" :class="{ active: currentStep === 3 }">
          <div class="step-num">3</div>
          <span>Живой мониторинг</span>
        </div>
      </div>

      <!-- STEP 1: CONFIGURATION -->
      <div v-if="currentStep === 1" class="step-content">
        <div class="sms-card">
          <h3 class="token-title">1. Параметры отправителя</h3>
          <div class="grid-3">
            <div class="input-group">
              <label>Выбор провайдера</label>
              <select v-model="selectedProvider" class="crm-input">
                <option value="dm">Dynamic Messaging</option>
                <option value="miatel">Miatel (Static Proxy)</option>
                <option value="fortytwo">FortyTwo Telecom</option>
                <option value="messagewhiz">MessageWhiz</option>
              </select>
            </div>

            <div v-if="selectedProvider === 'dm'" class="input-group">
              <label>DM Аккаунт</label>
              <select v-model="dmTokenKey" class="crm-input">
                <optgroup label="Маркетинг роуты">
                  <option value="DM_TOKEN_1">Account 1 (Main)</option>
                  <option value="DM_TOKEN_2">Account 2 (Antonie)</option>
                  <option value="DM_TOKEN_3">Account 3 (Michael)</option>
                  <option value="DM_TOKEN_4">Account 4 (Legendspin)</option>
                  <option value="DM_TOKEN_5">Account 5 (Softswiss)</option>
                </optgroup>
                <optgroup label="OTP роуты">
                  <option value="DM_OTP_TOKEN_1">OTP Account 1</option>
                  <option value="DM_OTP_TOKEN_2">OTP Account 2</option>
                </optgroup>
              </select>
            </div>

            <div class="input-group">
              <label>Sender ID (Имя отправителя)</label>
              <input 
                v-model="senderId" 
                type="text" 
                maxlength="11" 
                class="crm-input" 
                placeholder="e.g. Info" 
              />
              <span class="hint">{{ senderId.length }}/11 символов</span>
            </div>
          </div>
        </div>

        <!-- Filter Countries & Networks -->
        <div class="sms-card">
          <div class="card-header-flex">
            <h3 class="token-title">2. Выбор целевых стран и операторов</h3>
            <div class="btn-group-sm">
              <button class="crm-btn-sec" @click="selectAllCountries(true)">Выбрать все</button>
              <button class="crm-btn-sec" @click="selectAllCountries(false)">Очистить</button>
            </div>
          </div>

          <div v-if="loadingNetworks" class="loading-state">
            <span class="spinner">⏳</span> Загрузка доступных сетей из TelQ...
          </div>

          <div v-else class="countries-tags-grid">
            <label 
              v-for="c in availableCountries" 
              :key="c.mcc" 
              class="country-tag"
              :class="{ selected: selectedCountries.includes(c.name) }"
            >
              <input 
                type="checkbox" 
                :value="c.name" 
                :checked="selectedCountries.includes(c.name)"
                @change="toggleCountry(c.name)"
              />
              <span>{{ c.name }}</span>
            </label>
          </div>

          <!-- Networks Table -->
          <div v-if="filteredNetworks.length > 0" class="networks-table-wrapper">
            <table class="results-grid">
              <thead>
                <tr>
                  <th style="width: 40px">
                    <input 
                      type="checkbox" 
                      :checked="isAllFilteredSelected" 
                      @change="toggleAllNetworks(($event.target as HTMLInputElement).checked)" 
                    />
                  </th>
                  <th>Страна</th>
                  <th>Оператор / Сеть</th>
                  <th>MNC</th>
                  <th>MCC</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="net in filteredNetworks" :key="net._uid">
                  <td>
                    <input 
                      type="checkbox" 
                      :checked="net._uid !== undefined && selectedNetworkUids.has(net._uid)" 
                      @change="toggleNetworkUid(net._uid)"
                    />
                  </td>
                  <td><strong>{{ net.country }}</strong></td>
                  <td>{{ net.network }}</td>
                  <td><code>{{ net.mnc }}</code></td>
                  <td><code>{{ net.mcc }}</code></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="actions-row">
          <button 
            class="crm-btn-primary" 
            :disabled="selectedNetworksList.length === 0"
            @click="proceedToStep2"
          >
            Далее: Настройка языков ({{ selectedNetworksList.length }} сетей) →
          </button>
        </div>
      </div>

      <!-- STEP 2: LANGUAGES & MAPPING -->
      <div v-if="currentStep === 2" class="step-content">
        <div class="sms-card">
          <h3 class="token-title">Сопоставление языков и шаблонов СМС</h3>
          <p class="subtitle">Укажите язык для каждой выбранной страны. Текст сообщения подтянется из базы шаблонов.</p>

          <div v-if="loadingTemplates" class="loading-state">
            Загрузка шаблонов из базы...
          </div>

          <table v-else class="results-grid">
            <thead>
              <tr>
                <th>Страна</th>
                <th>Кол-во сетей</th>
                <th>Выбранный язык</th>
                <th>Текст СМС</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(lang, country) in countryLanguageMap" :key="country">
                <td><strong>{{ country }}</strong></td>
                <td>
                  <span class="badge-count">
                    {{ selectedNetworksList.filter(n => n.country === country).length }} сетей
                  </span>
                </td>
                <td>
                  <select v-model="countryLanguageMap[country]" class="crm-input">
                    <option 
                      v-for="t in (templatesMapping[country] || [])" 
                      :key="t.language" 
                      :value="t.language"
                    >
                      {{ t.language }} {{ t.isDefault ? '(Default)' : '' }}
                    </option>
                    <option v-if="!(templatesMapping[country] && templatesMapping[country].length)" value="English">
                      English (Fallback)
                    </option>
                  </select>
                </td>
                <td>
                  <div class="template-preview">
                    {{ getTemplateBody(String(country), countryLanguageMap[country]) }}
                  </div>
                </td>
                <td>
                  <button 
                    class="crm-btn-sec-sm"
                    @click="openEditTemplateModal(String(country), String(lang))"
                  >
                    ✏️ Редактировать
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="actions-row space-between">
          <button class="crm-btn-sec" @click="currentStep = 1">← Назад к выбору сетей</button>
          <button class="crm-btn-success" :disabled="creatingBatch" @click="startBatchProcess">
            <span v-if="creatingBatch">🚀 Инициализация...</span>
            <span v-else>🚀 Запустить кампанию СМС</span>
          </button>
        </div>
      </div>

      <!-- STEP 3: LIVE MONITORING -->
      <div v-if="currentStep === 3" class="step-content">
        <!-- Stats Summary Grid -->
        <div class="grid-4 mb-20">
          <div class="sms-card stat-card">
            <span class="stat-label">Всего номеров</span>
            <span class="stat-val">{{ activeTotal }}</span>
          </div>
          <div class="sms-card stat-card">
            <span class="stat-label">Отправлено</span>
            <span class="stat-val text-blue">{{ activeSent }}</span>
          </div>
          <div class="sms-card stat-card">
            <span class="stat-label">Доставлено</span>
            <span class="stat-val text-green">{{ activeDelivered }}</span>
          </div>
          <div class="sms-card stat-card">
            <span class="stat-label">Delivery Rate</span>
            <span class="stat-val text-emerald">{{ deliveryRate }}</span>
          </div>
        </div>

        <!-- Live Table -->
        <div class="sms-card">
          <div class="card-header-flex">
            <h3 class="token-title">Живой лог доставки (Опрос TelQ каждые 5 сек)</h3>
            <span class="pill" :class="getStatusBadgeClass(activeStatus)">
              {{ activeStatus.toUpperCase() }}
            </span>
          </div>

          <table class="results-grid">
            <thead>
              <tr>
                <th>Телефон</th>
                <th>MCC / MNC</th>
                <th>Sender ID</th>
                <th>Текст СМС</th>
                <th>Статус</th>
                <th>Задержка (сек)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="msg in activeMessagesList" :key="msg.id">
                <td><code>{{ msg.phoneNumber }}</code></td>
                <td>{{ msg.mcc }} / {{ msg.mnc }}</td>
                <td>{{ msg.senderId }}</td>
                <td class="text-truncate">{{ msg.messageBody }}</td>
                <td>
                  <span class="pill" :class="getStatusBadgeClass(msg.status)">
                    {{ msg.status }}
                  </span>
                </td>
                <td>{{ msg.latency ? `${msg.latency}s` : '-' }}</td>
              </tr>
              <tr v-if="activeMessagesList.length === 0">
                <td colspan="6" class="text-center py-20">Ожидание отправки сообщений воркером...</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="actions-row">
          <button class="crm-btn-primary" @click="resetToStep1">🔄 Запустить новую пачку</button>
        </div>
      </div>
    </div>

    <!-- TAB 2: HISTORY -->
    <div v-if="activeTab === 'history'" class="step-content">
      <div class="sms-card">
        <h3 class="token-title">История запущенных тестов</h3>
        <div v-if="loadingHistory" class="loading-state">Загрузка истории...</div>
        
        <table v-else class="results-grid">
          <thead>
            <tr>
              <th>Дата запуска</th>
              <th>Провайдер</th>
              <th>Всего сообщений</th>
              <th>Доставлено</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in historyCampaigns" :key="c.id">
              <td>{{ new Date(c.createdAt).toLocaleString('ru-RU') }}</td>
              <td><code class="uppercase">{{ c.provider }}</code></td>
              <td>{{ c.stats.total }}</td>
              <td>{{ c.stats.delivered }} / {{ c.stats.sent }}</td>
              <td>
                <span class="pill" :class="getStatusBadgeClass(c.status)">
                  {{ c.status.toUpperCase() }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Edit Template Modal -->
    <div v-if="editingTemplate" class="modal-overlay" @click.self="editingTemplate = null">
      <div class="sms-card modal-card">
        <h3 class="token-title">Редактирование шаблона ({{ editingTemplate.country }} - {{ editingTemplate.language }})</h3>
        <div class="input-group">
          <label>Текст маркетингового СМС</label>
          <textarea v-model="editingTemplate.body" class="crm-textarea" rows="4"></textarea>
        </div>
        <div class="actions-row right">
          <button class="crm-btn-sec" @click="editingTemplate = null">Отмена</button>
          <button class="crm-btn-primary" @click="saveTemplateChanges">Сохранить</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sms-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  font-family: inherit;
}

.sms-card {
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
}

.header-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.title-meta {
  display: flex;
  align-items: center;
  gap: 16px;
}

.service-icon {
  font-size: 32px;
}

.card-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: #18181b;
}

.subtitle {
  margin: 4px 0 0 0;
  font-size: 13px;
  color: #71717a;
}

.sub-tabs-nav {
  display: flex;
  gap: 8px;
  background: #f4f4f5;
  padding: 4px;
  border-radius: 8px;
}

.sub-tab-btn {
  border: none;
  background: transparent;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  color: #71717a;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.sub-tab-btn.sub-active {
  background: #ffffff;
  color: #0284c7;
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}

/* Stepper */
.stepper-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #ffffff;
  padding: 16px 32px;
  border-radius: 12px;
  border: 1px solid #e4e4e7;
}

.step-item {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #a1a1aa;
  font-weight: 600;
  font-size: 14px;
}

.step-item.active { color: #0284c7; }
.step-item.completed { color: #10b981; }

.step-num {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #f4f4f5;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}

.step-item.active .step-num { background: #0284c7; color: #fff; }
.step-item.completed .step-num { background: #10b981; color: #fff; }

.step-line {
  flex: 1;
  height: 2px;
  background: #e4e4e7;
  margin: 0 16px;
}

/* Forms & Inputs */
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }

.input-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.input-group label {
  font-size: 13px;
  font-weight: 600;
  color: #3f3f46;
}

.crm-input, .crm-textarea {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid #d4d4d8;
  border-radius: 8px;
  font-size: 14px;
  background: #fff;
  color: #18181b;
  outline: none;
}

.crm-input:focus, .crm-textarea:focus {
  border-color: #0284c7;
}

.hint { font-size: 11px; color: #a1a1aa; }

/* Tags & Table */
.countries-tags-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
  max-height: 180px;
  overflow-y: auto;
}

.country-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid #e4e4e7;
  border-radius: 20px;
  font-size: 13px;
  cursor: pointer;
  background: #fafafa;
}

.country-tag.selected {
  background: #e0f2fe;
  border-color: #38bdf8;
  color: #0369a1;
  font-weight: 600;
}

.networks-table-wrapper {
  margin-top: 20px;
  max-height: 350px;
  overflow-y: auto;
}

.results-grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.results-grid th, .results-grid td {
  padding: 10px 14px;
  border-bottom: 1px solid #f4f4f5;
  text-align: left;
}

.results-grid th {
  background: #fafafa;
  color: #71717a;
  font-weight: 600;
}

/* Actions */
.actions-row {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 20px;
}

.actions-row.space-between { justify-content: space-between; }

.crm-btn-primary {
  background: #0284c7;
  color: #fff;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
}

.crm-btn-success {
  background: #10b981;
  color: #fff;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
}

.crm-btn-sec {
  background: #f4f4f5;
  color: #3f3f46;
  border: 1px solid #d4d4d8;
  padding: 10px 16px;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
}

.crm-btn-sec-sm {
  background: #f4f4f5;
  border: 1px solid #d4d4d8;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}

/* Pills */
.pill {
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 700;
  display: inline-block;
}

.pill-green { background: #dcfce7; color: #15803d; }
.pill-red { background: #fee2e2; color: #b91c1c; }
.pill-blue { background: #e0f2fe; color: #0369a1; }
.pill-yellow { background: #fef3c7; color: #b45309; }

/* Stat Cards */
.stat-card { display: flex; flex-direction: column; gap: 4px; }
.stat-label { font-size: 12px; color: #71717a; font-weight: 600; }
.stat-val { font-size: 24px; font-weight: 800; color: #18181b; }
.text-blue { color: #0284c7; }
.text-green { color: #10b981; }
.text-emerald { color: #059669; }

/* Modal */
.modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-card { width: 500px; max-width: 90%; }
</style>

<!-- 
  =====================================================================
  🌙 DARK MODE (Железобетонный метод) 
  ===================================================================== 
-->
<style>
html[data-theme="dark"] .sms-panel .sms-card,
html[data-theme="dark"] .sms-panel .stepper-nav {
  background: #18181b !important;
  border-color: #27272a !important;
  box-shadow: 0 4px 6px rgba(0,0,0,0.3) !important;
}

html[data-theme="dark"] .sms-panel .card-title,
html[data-theme="dark"] .sms-panel .token-title,
html[data-theme="dark"] .sms-panel .stat-val {
  color: #f4f4f5 !important;
}

html[data-theme="dark"] .sms-panel .subtitle,
html[data-theme="dark"] .sms-panel .stat-label,
html[data-theme="dark"] .sms-panel .hint {
  color: #a1a1aa !important;
}

html[data-theme="dark"] .sms-panel .sub-tabs-nav {
  background: #09090b !important;
  border-color: #27272a !important;
}

html[data-theme="dark"] .sms-panel .sub-tab-btn {
  color: #71717a !important;
}

html[data-theme="dark"] .sms-panel .sub-tab-btn.sub-active {
  background: #27272a !important;
  color: #38bdf8 !important;
}

html[data-theme="dark"] .sms-panel .crm-input,
html[data-theme="dark"] .sms-panel .crm-textarea {
  background: #09090b !important;
  border-color: #27272a !important;
  color: #f4f4f5 !important;
}

html[data-theme="dark"] .sms-panel .crm-input:focus,
html[data-theme="dark"] .sms-panel .crm-textarea:focus {
  border-color: #38bdf8 !important;
}

html[data-theme="dark"] .sms-panel .country-tag {
  background: #09090b !important;
  border-color: #27272a !important;
  color: #a1a1aa !important;
}

html[data-theme="dark"] .sms-panel .country-tag.selected {
  background: rgba(56, 189, 248, 0.15) !important;
  border-color: #38bdf8 !important;
  color: #38bdf8 !important;
}

html[data-theme="dark"] .sms-panel .results-grid th {
  background: #09090b !important;
  color: #a1a1aa !important;
  border-color: #27272a !important;
}

html[data-theme="dark"] .sms-panel .results-grid td {
  background: #18181b !important;
  border-color: #27272a !important;
  color: #d4d4d8 !important;
}

html[data-theme="dark"] .sms-panel .crm-btn-sec,
html[data-theme="dark"] .sms-panel .crm-btn-sec-sm {
  background: #27272a !important;
  border-color: #3f3f46 !important;
  color: #f4f4f5 !important;
}

html[data-theme="dark"] .sms-panel .pill-green {
  background: rgba(16, 185, 129, 0.1) !important;
  color: #34d399 !important;
}

html[data-theme="dark"] .sms-panel .pill-red {
  background: rgba(239, 68, 68, 0.1) !important;
  color: #f87171 !important;
}

html[data-theme="dark"] .sms-panel .pill-blue {
  background: rgba(56, 189, 248, 0.1) !important;
  color: #38bdf8 !important;
}

html[data-theme="dark"] .sms-panel .pill-yellow {
  background: rgba(245, 158, 11, 0.1) !important;
  color: #fbbf24 !important;
}
</style>