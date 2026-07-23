<template>
  <div class="auditor-panel">
    
    <div class="auditor-card top-auth-bar">
      <div class="auth-bar-left">
        <span class="card-icon" style="font-size: 20px;">🔑</span>
        <span class="token-title" style="margin: 0; font-size: 15px;">Статус токенов авторизации</span>
      </div>
      
      <div class="auth-bar-right">
        <div v-for="env in ['env2', 'env5', 'env7', 'BO']" :key="env" class="auth-env-group">
          <span class="env-badge">{{ env }}</span>
          
          <button v-if="savedTokens[env]" class="token-state-btn" @click="clearToken(env)" v-tooltip="'Нажмите, чтобы удалить сохраненный токен для ' + env">
            <span class="icon-check">✓</span>
            <span class="icon-cross">✕</span>
          </button>

          <div v-else style="display: flex;">
            <input 
              type="password" 
              v-model="tokenInputs[env]" 
              placeholder="Вставить токен" 
              class="crm-input compact-input"
              style="border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: 0;"
              @keyup.enter="saveToken(env)"
              :disabled="isLoading"
              v-tooltip="'Введите токен авторизации для среды ' + env"
            />
            <button @click="saveToken(env)" class="crm-btn crm-btn-primary compact-btn" style="border-top-left-radius: 0; border-bottom-left-radius: 0;" v-tooltip="'Сохранить токен в память браузера'">Save</button>
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
        v-tooltip="tab.tooltip"
      >
        {{ tab.label }}
      </button>
    </div>

    <div v-if="activeTab === 'single'" class="auditor-card">
      <div class="inputs-grid">
        <div class="input-group">
          <label>📅 Ссылка на Scheduled кампанию</label>
          <input type="text" v-model="singleMainUrl" placeholder="https://drive.smartico.ai/2828#/j_audience_scheduled/" class="crm-input" :disabled="isLoading" v-tooltip="'Вставьте прямую ссылку на Scheduled кампанию из Smartico'" />
        </div>
        <div class="input-group">
          <label>🎯 Ссылка на Journey кампанию</label>
          <input type="text" v-model="singlePopUrl" placeholder="https://drive.smartico.ai/2828#/j_audience_head/" class="crm-input" :disabled="isLoading" v-tooltip="'Вставьте прямую ссылку на Journey кампанию из Smartico'" />
        </div>
      </div>
      <div class="settings-row mt-4" style="display: inline-flex; align-items: center; height: 52px; box-sizing: border-box; padding-right: 16px;">
        <label class="checkbox-label" style="margin: 0;" v-tooltip="'Активируйте для сбора реальной статистики прохождений по узлам Flow Map'">
          <input type="checkbox" v-model="useStats" :disabled="isLoading" />
          <span>📈 Собрать статистику по входам пользователей в кампанию</span>
        </label>
        
        <div style="width: 140px; margin-left: 16px; display: flex; align-items: center;">
          <div v-show="useStats" style="display: flex; align-items: center; gap: 8px;" v-tooltip="'Укажите, за сколько последних дней загружать статистику (от 1 до 90)'">
            <span style="font-size: 13px; opacity: 0.8;">за</span>
            <input type="number" v-model="daysBack" min="1" max="90" class="crm-input" style="width: 70px; padding: 4px 8px; text-align: center; height: 32px;" :disabled="isLoading" />
            <span style="font-size: 13px; opacity: 0.8;">дней</span>
          </div>
        </div>
      </div>
      <button @click="triggerSingleAudit" class="crm-btn crm-btn-success run-btn mt-5" :disabled="isLoading || (!singleMainUrl && !singlePopUrl)">
        {{ isLoading ? 'Processing...' : '🚀 Запустить одиночную проверку' }}
      </button>
    </div>

    <div v-if="activeTab === 'mass'" class="auditor-card">
      <div class="input-group">
        <label>🔗 Ссылки на кампании в Smartico. Одно окружение, по одной в строку.</label>
        <textarea v-model="massUrlsInput" rows="6" placeholder="Можно вставлять как Scheduled так и Journey кампании" class="crm-textarea" :disabled="isLoading" v-tooltip="'Вставьте список URL-адресов кампаний для массовой проверки (каждый URL с новой строки)'"></textarea>
      </div>
      <div class="settings-row mt-4" style="display: inline-flex; align-items: center; height: 52px; box-sizing: border-box; padding-right: 16px;">
        <label class="checkbox-label" style="margin: 0;" v-tooltip="'Активируйте для сбора реальной статистики прохождений по узлам Flow Map'">
          <input type="checkbox" v-model="useStats" :disabled="isLoading" />
          <span>Собрать статистику по входам пользователей в кампанию</span>
        </label>
        
        <div style="width: 140px; margin-left: 16px; display: flex; align-items: center;">
          <div v-show="useStats" style="display: flex; align-items: center; gap: 8px;" v-tooltip="'Укажите, за сколько последних дней загружать статистику (от 1 до 90)'">
            <span style="font-size: 13px; opacity: 0.8;">за</span>
            <input type="number" v-model="daysBack" min="1" max="90" class="crm-input" style="width: 70px; padding: 4px 8px; text-align: center; height: 32px;" :disabled="isLoading" />
            <span style="font-size: 13px; opacity: 0.8;">дней</span>
          </div>
        </div>
      </div>
      <button @click="triggerMassAudit" class="crm-btn crm-btn-success run-btn mt-5" :disabled="isLoading || !massUrlsInput.trim()">
        {{ isLoading ? 'Processing campaings List...' : '🚀 Запустить массовую проверку' }}
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
          <label>🔗 Список кампаний (по одной в строку)</label>
          <textarea v-model="brandSearchUrls" rows="4" class="crm-textarea" placeholder="Можно вставлять как Scheduled так и Journey кампании" v-tooltip="'Список кампаний, в которых будет производиться поиск совпадений'"></textarea>
        </div>
        <div class="input-group">
          <label>🔍 Название бренда / ключевое слово</label>
          <input type="text" v-model="brandSearchKeyword" placeholder="прим. Gamblerina" class="crm-input" v-tooltip="'Введите название бренда или ключевое слово для поиска внутри кампаний'" />
        </div>
        <button @click="executeBrandSearch" class="crm-btn crm-btn-success run-btn mt-5" :disabled="isLoading || !brandSearchKeyword || !brandSearchUrls">
          {{ isLoading ? 'Scanning...' : '🚀 Сканировать кампании' }}
        </button>
      </div>

      <div v-if="activeSubTab === 'labels'" style="display:flex; flex-direction:column; gap:16px;">
        <div class="inputs-grid">
          <div class="input-group">
            <label>Окружение</label>
            <select v-model="labelEnv" class="crm-input" v-tooltip="'Выберите окружение Smartico.'">
              <option value="env2">ENV 2</option>
              <option value="env5">ENV 5</option>
              <option value="env7">ENV 7</option>
            </select>
          </div>
          <div class="input-group">
            <label>Искомое значение вариации / ключевое слово</label>
            <input type="text" v-model="labelKeyword" placeholder="прим. Lamalucky" class="crm-input" v-tooltip="'Ключевое слово для поиска значения лейбла'" />
          </div>
        </div>
        <div class="input-group">
          <label>📋 Список лейблов для проверки (по одному в строку)</label>
          <textarea v-model="labelNamesInput" rows="4" class="crm-textarea" placeholder="crm2_brand_link" v-tooltip="'Названия лейблов для парсинга их настроек'"></textarea>
        </div>
        <button @click="executeBulkLabels" class="crm-btn crm-btn-success run-btn mt-5" :disabled="isLoading || !labelKeyword || !labelNamesInput">
          {{ isLoading ? 'Идет проверка' : '🚀 Сканировать лейблы' }}
        </button>
      </div>

      <div v-if="activeSubTab === 'links'" style="display:flex; flex-direction:column; gap:16px;">
        
        <div class="inputs-grid">
          <div class="input-group">
            <label>Окружение</label>
            <select v-model="labelEnv" class="crm-input" v-tooltip="'Выберите окружение Smartico.'">
              <option value="env2">ENV 2</option>
              <option value="env5">ENV 5</option>
              <option value="env7">ENV 7</option>
            </select>
          </div>
          <div class="input-group">
            <label>Искомое значение вариации / ключевое слово</label>
            <input type="text" v-model="labelKeyword" placeholder="прим. Lamalucky" class="crm-input" v-tooltip="'Ключевое слово для поиска значения лейбла перед развертыванием ссылки'" />
          </div>
        </div>

        <div class="input-group">
          <label>🔗 Список ссылок или лейблов (по одному в строку)</label>
          <textarea v-model="shortLinksInput" rows="5" class="crm-textarea" placeholder="crm2_brand_link&#10;rngsp.cc/xyz..." v-tooltip="'Сюда можно вставлять вперемешку и названия лейблов, и готовые шорт-линки'"></textarea>
        </div>
        
        <button @click="executeResolveLinks" class="crm-btn crm-btn-success run-btn mt-5" :disabled="isLoading || !shortLinksInput">
          {{ isLoading ? 'Идет проверка...' : '🚀 Сканировать ссылки' }}
        </button>
      </div>
    </div>
    
    <div v-if="activeTab === 'backoffice'" class="auditor-card">
      
      <div class="input-group">
        <label>🏢 Название бренда</label>
        <input type="text" v-model="boBrand" placeholder="прим. frogyspin" class="crm-input" :disabled="isLoading" v-tooltip="'Укажите имя бренда из octo: прим. ringospin, spinstein)'" />
      </div>

      <!-- Добавленный выбор типа материалов -->
      <div class="input-group mt-4">
        <label style="margin-bottom: 8px;">🎯 Тип материалов для проверки</label>
        <div class="settings-row" style="justify-content: flex-start; gap: 24px; padding: 12px 16px;">
          <label class="checkbox-label" v-tooltip="'Искать и проверять Баннеры'">
            <input type="checkbox" value="banner" v-model="boTargets" :disabled="isLoading" />
            <span>🖼️ Баннеры</span>
          </label>
          <label class="checkbox-label" v-tooltip="'Искать и проверять Промо-карты'">
            <input type="checkbox" value="promotion" v-model="boTargets" :disabled="isLoading" />
            <span>🃏 Промо-карты</span>
          </label>
        </div>
      </div>

      <div class="input-group mt-4">
        <!-- Заголовок блока и аккуратная кнопка настройки в одну линию -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <label style="margin-bottom: 0;">🌍 ГЕО для проверки</label>
          <button 
            @click="isEditingFavorites = !isEditingFavorites" 
            class="crm-btn compact-btn crm-btn-primary" 
            :style="isEditingFavorites ? 'background-color: #059669;' : ''"
            style="width: 130px; padding: 4px 0; font-size: 12px; border-radius: 6px; box-shadow: none; text-align: center;"
            v-tooltip="'Отметьте ГЕО звездочками, чтобы закрепить их в начале списка'"
          >
            {{ isEditingFavorites ? '✅ Завершить' : '⚙️ Закрепить' }}
          </button>
        </div>
        
        <div class="all-geo-row">
          <label class="checkbox-label geo-item" v-tooltip="'При выборе ALL скрипт просканирует офферы не настроенные на конкретное ГЕО '">
            <input type="checkbox" value="ALL" v-model="boGeos" :disabled="isLoading" />
            <span class="geo-label-text" style="font-weight: bold; color: #3b82f6;">🌍 ALL (Global offers)</span>
          </label>
        </div>

        <div class="geo-grid">
          <div 
            v-for="geo in sortedGeoOptions" 
            :key="geo.code" 
            class="geo-wrapper" 
            :class="{'is-fav': favoriteGeos.includes(geo.code)}"
          >
            <label class="checkbox-label geo-item" v-tooltip="'Отметьте для сканирования кампаний, нацеленных на ГЕО: ' + geo.code">
              <input type="checkbox" :value="geo.code" v-model="boGeos" :disabled="isLoading" />
              <span class="geo-label-text">
                {{ geo.flag }} {{ geo.code }}
              </span>
            </label>
            
            <span 
              v-if="isEditingFavorites"
              class="fav-star" 
              @click.stop.prevent="toggleFavoriteGeo(geo.code)"
              v-tooltip="favoriteGeos.includes(geo.code) ? 'Убрать ГЕО из избранного' : 'Закрепить ГЕО вверху списка'"
            >
              {{ favoriteGeos.includes(geo.code) ? '⭐' : '☆' }}
            </span>
          </div>
        </div>
      </div>

      <!-- Кнопка запуска активна, если: Токен BO + Бренд + выбрано ГЕО + выбран тип материалов -->
      <button 
        @click="runBackofficeAudit" 
        class="crm-btn crm-btn-success run-btn mt-5" 
        :disabled="isLoading || !savedTokens['BO'] || !boBrand.trim() || boGeos.length === 0 || boTargets.length === 0"
      >
        {{ isLoading ? 'Сканирование контента...' : '🚀 Запустить сканнер контента' }}
      </button>
    </div>

    <!-- ... (Терминал, Таблицы и Результаты остаются без изменений, туда тултипы не нужны) ... -->
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
      <!-- Блок результатов -->
      <h4 class="card-title mb-4">📊 Результат:</h4>
      
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

      <!-- Таблица для парсера лейблов (2 колонки) -->
      <div v-if="activeSubTab === 'labels' && activeTab === 'brands'" style="overflow-x: auto; border-radius: 8px;">
        <table class="results-grid">
          <thead>
            <tr>
              <th>Имя лейбла (Key)</th>
              <th>Значение из словаря</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(val, key) in tableResults" :key="key">
              <td class="table-key-cell" style="width: 30%;">{{ key }}</td>
              <td class="table-value-cell">{{ val }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Таблица для парсера шорт-линков (3 колонки) -->
      <div v-if="activeSubTab === 'links' && activeTab === 'brands'" style="overflow-x: auto; border-radius: 8px;">
        <table class="results-grid">
          <thead>
            <tr>
              <th>Ввод (Лейбл или ссылка)</th>
              <th>Шорт-линк</th>
              <th>Развернутая ссылка</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(val, key) in tableResults" :key="key">
              <!-- 1. Имя лейбла или изначальный ввод -->
              <td class="table-key-cell" style="width: 25%;">{{ key }}</td>
              
              <!-- 2. Шорт-линк -->
              <td class="table-value-cell" style="width: 25%;">
                <template v-if="typeof val === 'object' && val !== null">
                  <span :style="{ color: val.short && (val.short.includes('❌') || val.short.includes('⚠️')) ? '#ef4444' : '#8b5cf6', fontWeight: 'bold' }">
                    {{ val.short }}
                  </span>
                </template>
              </td>
              
              <!-- 3. Развернутый линк -->
              <td class="table-value-cell" style="width: 50%;">
                <template v-if="typeof val === 'object' && val !== null">
                  <div v-if="val.status === 'error' && val.full" style="color: #ef4444; font-weight: 500;">
                    {{ val.full }}
                  </div>
                  <div v-else-if="val.full">
                    <a :href="val.full" target="_blank" style="color: #3b82f6; text-decoration: none; word-break: break-all;">
                      {{ val.full }}
                    </a>
                  </div>
                  <div v-else style="color: #64748b; font-style: italic;">
                    -
                  </div>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="auditor-card result-card" v-if="finalHtml && !isLoading">
      <div class="result-content">
        <div class="result-icon">🎉</div>
        <div class="result-text">
          <h3>Отчет успешно сгенерирован!</h3>
        </div>
        <button @click="downloadHtml" class="crm-btn crm-btn-success download-btn">📥 Скачать</button>
      </div>
    </div>

  </div>
</template>

<script setup>

import { ref, computed, onMounted, nextTick, watch } from 'vue';

// ==========================================
// 💡 ДИРЕКТИВА ВСПЛЫВАЮЩИХ ПОДСКАЗОК (3 сек)
// ==========================================
const vTooltip = {
  mounted(el, binding) {
    if (!binding.value) return;
    
    let timeout;
    let tooltipEl;

    const show = () => {
      // Создаем элемент
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'crm-tooltip';
      tooltipEl.textContent = binding.value;
      document.body.appendChild(tooltipEl);

      // Рассчитываем позицию (по умолчанию сверху по центру)
      const rect = el.getBoundingClientRect();
      const tooltipRect = tooltipEl.getBoundingClientRect();
      
      let top = rect.top + window.scrollY - tooltipRect.height - 8;
      let left = rect.left + window.scrollX + (rect.width / 2) - (tooltipRect.width / 2);
      
      // Если сверху не хватает места — показываем снизу
      if (top < window.scrollY) top = rect.bottom + window.scrollY + 8;
      
      tooltipEl.style.top = `${top}px`;
      tooltipEl.style.left = `${left}px`;
      
      // Даем время на рендер перед включением прозрачности (анимация)
      requestAnimationFrame(() => {
        tooltipEl.classList.add('visible');
      });
    };

    const hide = () => {
      if (tooltipEl) {
        tooltipEl.classList.remove('visible');
        const elToRemove = tooltipEl;
        setTimeout(() => { if (elToRemove.parentNode) elToRemove.remove() }, 200);
        tooltipEl = null;
      }
    };

    el.addEventListener('mouseenter', () => {
      timeout = setTimeout(show, 1500);
    });

    el.addEventListener('mouseleave', () => {
      clearTimeout(timeout);
      hide();
    });

    // Прячем подсказку, если начали вводить текст
    el.addEventListener('focus', () => {
      clearTimeout(timeout);
      hide();
    });

    el._cleanupTooltip = () => {
      clearTimeout(timeout);
      hide();
    };
  },
  unmounted(el) {
    if (el._cleanupTooltip) el._cleanupTooltip();
  }
};

const tabs = [
  { id: 'single', label: '🗺️ Одиночная проверка', tooltip: 'Углубленная проверка одной кампании (Scheduled и Journey)' },
  { id: 'mass', label: '🕵️‍♂️ Массовая проверка', tooltip: 'Проверка реальных отправок пользователям для списка кампаний' },
  { id: 'brands', label: '🏷️ Brands Tools', tooltip: 'Парсинг кампаний, лейблов, шорт-линков' },
  { id: 'backoffice', label: '🎰 Сканнер контента', tooltip: 'Сверка заполнения значений активных бонусов с промо-материалами' } 
];

const subTabs = [
  { id: 'search', label: '🔍 Парсер кампаний' },
  { id: 'labels', label: '🔠 Парсер лейблов' },
  { id: 'links', label: '🔗 Парсер шорт-линков' }
];

const activeTab = ref('single');
const activeSubTab = ref('search');
const savedTokens = ref({ env2: '', env5: '', env7: '', BO: '' });
const tokenInputs = ref({ env2: '', env5: '', env7: '', BO: '' });

const singleMainUrl = ref('');
const singlePopUrl = ref('');
const massUrlsInput = ref('');
const useStats = ref(false);
const daysBack = ref(14);

const brandSearchUrls = ref('');
const brandSearchKeyword = ref('');
const labelEnv = ref('env2');
const labelKeyword = ref('');
const labelNamesInput = ref('');
const shortLinksInput = ref('');

const boBrand = ref('');
const boOfferText = ref('');
const boTargets = ref([]); 
const boGeos = ref([]);


watch(boGeos, (newVal) => localStorage.setItem('bo_geos', JSON.stringify(newVal)));
watch(boTargets, (newVal) => localStorage.setItem('bo_targets', JSON.stringify(newVal)));

// 🌍 Карта ГЕО с флагами
const geoOptions = [
  { code: 'BR', flag: '🇧🇷' }, { code: 'PT', flag: '🇵🇹' }, { code: 'AU', flag: '🇦🇺' },
  { code: 'CA', flag: '🇨🇦' }, { code: 'NZ', flag: '🇳🇿' }, { code: 'IE', flag: '🇮🇪' },
  { code: 'KR', flag: '🇰🇷' }, { code: 'DK', flag: '🇩🇰' }, { code: 'FI', flag: '🇫🇮' },
  { code: 'DE', flag: '🇩🇪' }, { code: 'AT', flag: '🇦🇹' }, { code: 'CH', flag: '🇨🇭' },
  { code: 'PL', flag: '🇵🇱' }, { code: 'CZ', flag: '🇨🇿' }, { code: 'HU', flag: '🇭🇺' },
  { code: 'NO', flag: '🇳🇴' }, { code: 'RO', flag: '🇷🇴' }, { code: 'SK', flag: '🇸🇰' },
  { code: 'SI', flag: '🇸🇮' }, { code: 'HR', flag: '🇭🇷' }, { code: 'MK', flag: '🇲🇰' },
  { code: 'RS', flag: '🇷🇸' }, { code: 'GR', flag: '🇬🇷' }, { code: 'ES', flag: '🇪🇸' },
  { code: 'IT', flag: '🇮🇹' }, { code: 'NL', flag: '🇳🇱' }, { code: 'GB', flag: '🇬🇧' },
  { code: 'FR', flag: '🇫🇷' }
];

const favoriteGeos = ref([]);
const isEditingFavorites = ref(false); // 🚨 Флаг режима редактирования звездочек

// Сортированный список: сначала избранные, потом все остальные
const sortedGeoOptions = computed(() => {
  const favs = geoOptions.filter(g => favoriteGeos.value.includes(g.code));
  const others = geoOptions.filter(g => !favoriteGeos.value.includes(g.code));
  return [...favs, ...others];
});

// Функция добавления/удаления из избранного
function toggleFavoriteGeo(code) {
  if (favoriteGeos.value.includes(code)) {
    favoriteGeos.value = favoriteGeos.value.filter(c => c !== code);
  } else {
    favoriteGeos.value.push(code);
  }
  localStorage.setItem('bo_fav_geos', JSON.stringify(favoriteGeos.value));
}

const isLoading = ref(false);
const progress = ref(0);
const logs = ref([]);
const finalHtml = ref('');
const tableResults = ref(null);
const terminalRef = ref(null);
const reportFilename = ref('Report.html');

onMounted(() => {
  // 1. Загрузка токенов с проверкой времени жизни (TTL)
  ['env2', 'env5', 'env7', 'BO'].forEach(env => {
    const storageKey = env === 'BO' ? 'bo_auth_token' : `smartico_token_${env}`;
    const rawData = localStorage.getItem(storageKey);
    if (rawData) {
      try {
        const parsed = JSON.parse(rawData);
        if (parsed.expiry && Date.now() > parsed.expiry) {
          // Время вышло — удаляем токен
          localStorage.removeItem(storageKey);
        } else if (parsed.value) {
          // Токен еще жив — восстанавливаем
          savedTokens.value[env] = parsed.value;
          tokenInputs.value[env] = parsed.value;
        }
      } catch (e) {
        // Если формат старый (простой текст), удаляем, чтобы перезаписать в новом формате
        localStorage.removeItem(storageKey);
      }
    }
  });

  // 2. Восстанавливаем ГЕО (вынесено из цикла для оптимизации)
  const savedGeos = localStorage.getItem('bo_geos');
  if (savedGeos) {
    try { boGeos.value = JSON.parse(savedGeos); } catch (e) {}
  }

  // 3. Восстанавливаем выбранные типы (Promotions/Banners)
  const savedTargets = localStorage.getItem('bo_targets');
  if (savedTargets) {
    try { boTargets.value = JSON.parse(savedTargets); } catch (e) {}
  }

  // 4. Загрузка избранных ГЕО
  const savedFavs = localStorage.getItem('bo_fav_geos');
  if (savedFavs) {
    try { favoriteGeos.value = JSON.parse(savedFavs); } catch (e) {}
  }
});

function saveToken(env) {
  if (tokenInputs.value[env].trim()) {
    const tokenValue = tokenInputs.value[env].trim();
    savedTokens.value[env] = tokenValue;
    const storageKey = env === 'BO' ? 'bo_auth_token' : `smartico_token_${env}`;
    
    // Считаем время жизни: BO = 24 часа, остальные = 48 часов
    const ttlHours = env === 'BO' ? 24 : 48;
    const expiryTime = Date.now() + (ttlHours * 60 * 60 * 1000);
    
    // Сохраняем как JSON с указанием времени смерти
    localStorage.setItem(storageKey, JSON.stringify({ 
      value: tokenValue, 
      expiry: expiryTime 
    }));
  }
}

function clearToken(env) {
  savedTokens.value[env] = '';
  tokenInputs.value[env] = '';
  const storageKey = env === 'BO' ? 'bo_auth_token' : `smartico_token_${env}`;
  localStorage.removeItem(storageKey);
}

function extractEnvFromUrl(url) {
  if (!url) return 'env2';
  if (url.includes('drive-7') || url.includes('drive7')) return 'env7';
  if (url.includes('drive-5') || url.includes('drive5')) return 'env5';
  return 'env2';
}

watch(logs, async () => {
}, { deep: true });

// ==========================================
// 🚀 ОСНОВНОЙ ПАЙПЛАЙН АУДИТА (СТРИМИНГ)
// ==========================================
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

  // 🚨 Динамически выбираем роут нашего Node.js прокси
  const endpoint = activeTab.value === 'single' ? '/api/qa-tools/single-audit' : '/api/qa-tools/mass-audit';

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: urlList, // Для массы
        main_url: urlList[0], // Для одиночного
        pop_url: urlList[1] || '', // Для одиночного
        token: activeToken,
        use_stats: useStats.value,
        days_back: daysBack.value
      })
    });

    if (!response.ok) throw new Error(`Gateway response runtime assertion failure: HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let streamBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      streamBuffer += decoder.decode(value, { stream: true });
      const lines = streamBuffer.split('\n\n'); // SSE чанки разделяются двумя переносами
      streamBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const rawPayload = line.replace('data: ', '').trim();
          if (!rawPayload) continue;

          try {
            const parsed = JSON.parse(rawPayload);
            if (parsed.type === 'progress') {
              logs.value.push(`<span class="log-time">>></span> ${parsed.msg}`);
              if (parsed.percent) progress.value = parsed.percent;
            } else if (parsed.type === 'done') {
              // 🚨 Теперь HTML отдается сразу, без второго запроса на скачивание!
              finalHtml.value = parsed.html_content;
              if (parsed.filename) reportFilename.value = parsed.filename;
              progress.value = 100;
              logs.value.push(`<span class="log-success">>> ✅ Document composition finalized successfully.</span>`);
              isLoading.value = false;
              return;
            } else if (parsed.type === 'error') {
              logs.value.push(`<span class="log-err">>> ❌ Remote execution exception: ${parsed.msg}</span>`);
              isLoading.value = false;
              return;
            }
          } catch (e) {
            // Игнорируем битые куски парсинга
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

// ==========================================
// 🚀 BACKOFFICE AUDIT (СТРИМИНГ)
// ==========================================
async function runBackofficeAudit() {
  isLoading.value = true;
  progress.value = 0;
  logs.value = [];
  finalHtml.value = '';
  tableResults.value = null;

  if (!savedTokens.value['BO']) {
    logs.value.push(`<span class="log-err">>> ❌ Missing authentication key for Backoffice!</span>`);
    isLoading.value = false;
    return;
  }
  
  if (!boBrand.value) {
    logs.value.push(`<span class="log-err">>> ❌ Brand Name is required!</span>`);
    isLoading.value = false;
    return;
  }

  try {
    const response = await fetch('/api/qa-tools/backoffice-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offer_text: boOfferText.value,
        brand: boBrand.value.trim().toLowerCase(),
        targets: boTargets.value,
        token: savedTokens.value['BO'].trim(),
        target_geos: boGeos.value
      })
    });

    if (!response.ok) throw new Error(`Gateway response error: HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let streamBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      streamBuffer += decoder.decode(value, { stream: true });
      const lines = streamBuffer.split('\n\n');
      streamBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const rawPayload = line.replace('data: ', '').trim();
          if (!rawPayload) continue;

          try {
            const parsed = JSON.parse(rawPayload);
            if (parsed.type === 'progress') {
              logs.value.push(`<span class="log-time">>></span> ${parsed.msg}`);
            } else if (parsed.type === 'done') {
              finalHtml.value = parsed.html_content;
              if (parsed.filename) reportFilename.value = parsed.filename;
              progress.value = 100;
              logs.value.push(`<span class="log-success">>> ✅ Backoffice audit completed successfully.</span>`);
              isLoading.value = false;
              return;
            } else if (parsed.type === 'error') {
              logs.value.push(`<span class="log-err">>> ❌ Error: ${parsed.msg}</span>`);
              isLoading.value = false;
              return;
            }
          } catch (e) {
            // Игнорируем битые куски парсинга
          }
        }
      }
    }
  } catch (err) {
    logs.value.push(`<span class="log-err">>> ❌ Transport error: ${err.message}</span>`);
    isLoading.value = false;
  }
}

// ==========================================
// 🏷️ БРЕНДЫ И ЛЕЙБЛЫ
// ==========================================
async function executeBrandSearch() {
  isLoading.value = true;
  tableResults.value = null;
  const urls = brandSearchUrls.value.split('\n').map(u => u.trim()).filter(u => !!u);
  const token = savedTokens.value[extractEnvFromUrl(urls[0])];

  try {
    const res = await fetch('/api/qa-tools/brands/search-campaigns', {
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

  try {
    const res = await fetch('/api/qa-tools/brands/bulk-labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        env: labelEnv.value,          // 👈 Отправляем env, как ждет FastAPI
        keyword: labelKeyword.value, 
        labels: labels, 
        token: token 
      })
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
  
  const env = labelEnv.value || 'env2';
  const token = savedTokens.value[env] || '';

  try {
    const res = await fetch('/api/qa-tools/brands/resolve-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        env: env,
        keyword: labelKeyword.value || '', 
        items: links,                      
        token: token
      })
    });
    const data = await res.json();
    
    tableResults.value = data.resolved_links; 
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
  a.download = reportFilename.value;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<style scoped>
/* =====================================================================
   🎨 BASE CSS (Каркас и Светлая тема)
   ===================================================================== */
.auditor-panel { display: flex; flex-direction: column; gap: 20px; width: 100%; font-family: system-ui, -apple-system, sans-serif; }
.auditor-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); width: 100%; box-sizing: border-box; transition: all 0.2s; }
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

/* --- 🛡️ UI Токенов (Smart Button) --- */
.token-state-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #dcfce7;
  color: #10b981;
  border: 1px solid #bbf7d0;
  border-radius: 6px;
  height: 31px;
  width: 31px; /* Квадратная форма */
  cursor: pointer;
  font-weight: bold;
  font-size: 16px;
  padding: 0;
  transition: all 0.2s ease;
}

.token-state-btn .icon-cross {
  display: none; /* Скрываем крестик по умолчанию */
}

/* Эффект при наведении мыши */
.token-state-btn:hover {
  background: #fee2e2;
  color: #ef4444;
  border-color: #fca5a5;
}

.token-state-btn:hover .icon-check {
  display: none; /* Скрываем галочку при наведении */
}

.token-state-btn:hover .icon-cross {
  display: block; /* Показываем крестик при наведении */
}

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

/* --- 🌍 GEO Grid --- */
/* --- 🌍 GEO Grid & Favorites --- */
.geo-grid {
  display: grid;
  /* Увеличили ширину колонки с 75px до 105px, чтобы Global влезал идеально */
  grid-template-columns: repeat(auto-fill, minmax(105px, 1fr));
  gap: 8px 12px;
  background: #f8fafc;
  padding: 16px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
}

.geo-wrapper {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  transition: background 0.2s;
}

.geo-wrapper:hover {
  background: #f1f5f9;
}

/* Выделение избранных ГЕО легким зеленым фоном */
.geo-wrapper.is-fav {
  background: #f0fdf4; 
  border-color: #bbf7d0;
}

.geo-item {
  margin: 0;
  font-family: monospace;
  font-size: 14px;
  flex: 1; 
}

/* Запрещаем тексту съезжать на вторую строку */
.geo-label-text {
  white-space: nowrap; 
}

/* Стили для звездочки (Режим редактирования) */
.fav-star {
  cursor: pointer;
  font-size: 16px;
  transition: transform 0.2s;
  user-select: none;
  padding-left: 4px;
  opacity: 0.5; /* Пустые звезды чуть приглушены */
}

.fav-star:hover {
  transform: scale(1.2);
  opacity: 1;
}

.geo-wrapper.is-fav .fav-star {
  opacity: 1; /* Выбранные звезды светятся ярко */
}

.geo-wrapper:hover .fav-star {
  opacity: 0.8;
}

.fav-star:hover {
  transform: scale(1.2);
  opacity: 1 !important;
}

.geo-wrapper.is-fav .fav-star {
  opacity: 1;
}

/* --- Отдельный блок ALL --- */
.all-geo-row {
  background: #f8fafc;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  margin-bottom: 12px; /* Отступ до основной сетки */
  box-sizing: border-box;
}
</style>



<!-- 
  =====================================================================
  🌙 DARK MODE (Железобетонный метод) 
  Отдельный тег style БЕЗ слова "scoped", чтобы точно пробить изоляцию Vue!
  ===================================================================== 
-->
<style>
html[data-theme="dark"] .auditor-panel .auditor-card { background: #18181b !important; border-color: #27272a !important; box-shadow: 0 4px 6px rgba(0,0,0,0.3) !important; }
html[data-theme="dark"] .auditor-panel .card-title, 
html[data-theme="dark"] .auditor-panel .token-title, 
html[data-theme="dark"] .auditor-panel .env-label, 
html[data-theme="dark"] .auditor-panel .checkbox-label span, 
html[data-theme="dark"] .auditor-panel .days-input label { color: #f4f4f5 !important; }
html[data-theme="dark"] .auditor-panel .input-group label { color: #a1a1aa !important; }

/* Dark mode overrides */
html[data-theme="dark"] .auditor-panel .tabs-nav { border-color: #27272a !important; }
html[data-theme="dark"] .auditor-panel .tab-btn:hover:not(:disabled) { color: #f4f4f5 !important; }
html[data-theme="dark"] .auditor-panel .tab-active { color: #38bdf8 !important; border-bottom-color: #38bdf8 !important; }
html[data-theme="dark"] .auditor-panel .sub-tabs-nav { background: #09090b !important; border-color: #27272a !important; }
html[data-theme="dark"] .auditor-panel .sub-tab-btn { color: #71717a !important; }
html[data-theme="dark"] .auditor-panel .sub-tab-btn:hover { color: #e4e4e7 !important; }
html[data-theme="dark"] .auditor-panel .sub-active { background: #27272a !important; color: #38bdf8 !important; border-color: #27272a !important; box-shadow: none !important; }

html[data-theme="dark"] .auditor-panel .crm-input, 
html[data-theme="dark"] .auditor-panel .crm-textarea { background: #09090b !important; border-color: #27272a !important; color: #f4f4f5 !important; }
html[data-theme="dark"] .auditor-panel .crm-input:focus, 
html[data-theme="dark"] .auditor-panel .crm-textarea:focus { border-color: #38bdf8 !important; }
html[data-theme="dark"] .auditor-panel .settings-row { background: #09090b !important; border-color: #27272a !important; }

/* Status Pills Dark */
html[data-theme="dark"] .auditor-panel .pill-green { background: rgba(16, 185, 129, 0.1) !important; color: #34d399 !important; border-color: rgba(16, 185, 129, 0.2) !important; }
html[data-theme="dark"] .auditor-panel .pill-red { background: rgba(239, 68, 68, 0.1) !important; color: #f87171 !important; border-color: rgba(239, 68, 68, 0.2) !important; }

/* Table Results Dark */
html[data-theme="dark"] .auditor-panel .table-results-nested { border-color: #27272a !important; background: #09090b !important; }
html[data-theme="dark"] .auditor-panel .nested-header { border-color: #27272a !important; color: #f4f4f5 !important; }
html[data-theme="dark"] .auditor-panel .nested-row-match { background: #18181b !important; border-color: #27272a !important; color: #a1a1aa !important; }
html[data-theme="dark"] .auditor-panel .match-success { background: rgba(16, 185, 129, 0.1) !important; color: #34d399 !important; border-color: rgba(16, 185, 129, 0.2) !important; }

html[data-theme="dark"] .auditor-panel .results-grid th { background: #09090b !important; color: #a1a1aa !important; border-color: #27272a !important; }
html[data-theme="dark"] .auditor-panel .results-grid td { background: #18181b !important; border-color: #27272a !important; color: #d4d4d8 !important; }

/* Terminal Dark */
html[data-theme="dark"] .auditor-panel .terminal-card { background: #18181b !important; border-color: #27272a !important; }
html[data-theme="dark"] .auditor-panel .terminal { background: transparent !important; color: #e4e4e7 !important; }

/* Result Card Dark */
html[data-theme="dark"] .auditor-panel .result-card { background: rgba(6, 78, 59, 0.2) !important; border-color: rgba(4, 120, 87, 0.4) !important; }
html[data-theme="dark"] .auditor-panel .result-text h3 { color: #34d399 !important; }
html[data-theme="dark"] .auditor-panel .result-text p { color: #a7f3d0 !important; }

/* Token UI Dark (Smart Button) */
html[data-theme="dark"] .auditor-panel .token-state-btn { 
  background: rgba(16, 185, 129, 0.1) !important; 
  color: #10b981 !important; 
  border-color: rgba(16, 185, 129, 0.2) !important; 
}
html[data-theme="dark"] .auditor-panel .token-state-btn:hover { 
  background: rgba(239, 68, 68, 0.15) !important; 
  color: #f87171 !important; 
  border-color: rgba(239, 68, 68, 0.3) !important; 
}

/* GEO Grid Dark */
html[data-theme="dark"] .auditor-panel .geo-grid { 
  background: #09090b !important; 
  border-color: #27272a !important; 
}

/* GEO Grid Dark Mode Fixes */
html[data-theme="dark"] .auditor-panel .geo-grid { background: #09090b !important; border-color: #27272a !important; }
html[data-theme="dark"] .auditor-panel .geo-wrapper:hover { background: #18181b !important; }
html[data-theme="dark"] .auditor-panel .geo-wrapper.is-fav { background: rgba(16, 185, 129, 0.05) !important; border-color: rgba(16, 185, 129, 0.2) !important; }

/* Блок ALL Dark Mode */
html[data-theme="dark"] .auditor-panel .all-geo-row { background: #09090b !important; border-color: #27272a !important; }

/* Favorite GEOs Text Dark Mode */
html[data-theme="dark"] .auditor-panel .fav-title { color: #f4f4f5 !important; }
html[data-theme="dark"] .auditor-panel .fav-subtitle { color: #a1a1aa !important; }

/* =====================================================================
   💡 TOOLTIP STYLES (Глобальные)
   ===================================================================== */
.crm-tooltip {
  position: absolute;
  background: #1e293b;
  color: #f8fafc;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-family: system-ui, -apple-system, sans-serif;
  pointer-events: none; /* Чтобы мышка сквозь них проходила */
  z-index: 99999;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  opacity: 0;
  transition: opacity 0.2s ease, transform 0.2s ease;
  transform: translateY(4px);
  white-space: pre-wrap;
  max-width: 280px;
  text-align: center;
  font-weight: 500;
  letter-spacing: 0.3px;
}

.crm-tooltip.visible {
  opacity: 1;
  transform: translateY(0);
}

/* Tooltip Dark Mode */
html[data-theme="dark"] .crm-tooltip {
  background: #e2e8f0;
  color: #0f172a;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.5);
}
</style>