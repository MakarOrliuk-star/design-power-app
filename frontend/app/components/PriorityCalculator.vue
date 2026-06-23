<template>
  <div class="calculator-wrapper">
    <div class="container">
      <h1>Task Scoring System</h1>

      <label for="difficulty">Сложность</label>
      <select v-model="difficulty" id="difficulty">
        <option>Легко</option>
        <option>Средне</option>
        <option>Сложно</option>
      </select>

      <label for="confidence">Уверенность</label>
      <select v-model="confidence" id="confidence">
        <option>Низкая</option>
        <option>Средняя</option>
        <option>Высокая</option>
      </select>

      <label for="financial">Финансовый эффект</label>
      <select v-model="financial" id="financial">
        <option>Высокий</option>
        <option>Средний</option>
        <option>Маленький</option>
      </select>

      <h2 id="score" :class="priorityClass">Priority: {{ priorityScore }}</h2>

      <div class="info">
        <p><strong>Сложность:</strong> Насколько сложно и долго выполнить задачу</p>
        <p><strong>Уверенность:</strong> Степень уверенности в ожидаемом результате</p>
        <p><strong>Финансовый эффект:</strong> Как сильно выполнение задачи повлияет на доход</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const difficulty = ref('Легко');
const confidence = ref('Низкая');
const financial = ref('Высокий');


const priorityMatrix = {
  'Легко': {
    'Низкая': { 'Высокий': 'Medium', 'Средний': 'Low', 'Маленький': 'Lowest' },
    'Средняя': { 'Высокий': 'High', 'Средний': 'Medium', 'Маленький': 'Low' },
    'Высокая': { 'Высокий': 'High', 'Средний': 'High', 'Маленький': 'Low' }
  },
  'Средне': {
    'Низкая': { 'Высокий': 'Medium', 'Средний': 'Low', 'Маленький': 'Lowest' },
    'Средняя': { 'Высокий': 'High', 'Средний': 'Medium', 'Маленький': 'Low' },
    'Высокая': { 'Высокий': 'High', 'Средний': 'Medium', 'Маленький': 'Low' }
  },
  'Сложно': {
    'Низкая': { 'Высокий': 'Medium', 'Средний': 'Low', 'Маленький': 'Lowest' },
    'Средняя': { 'Высокий': 'High', 'Средний': 'Medium', 'Маленький': 'Low' },
    'Высокая': { 'Высокий': 'High', 'Средний': 'Medium', 'Маленький': 'Low' }
  }
};


const priorityScore = computed(() => {
  return priorityMatrix[difficulty.value]?.[confidence.value]?.[financial.value] || "Unknown";
});


const priorityClass = computed(() => {
  if (priorityScore.value === "High") return "priority-High";
  if (priorityScore.value === "Medium") return "priority-Medium";
  return "priority-Low"; // Используется для Low и Lowest
});
</script>

<style scoped>
* {
  box-sizing: border-box;
}

.calculator-wrapper {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 20px;
  background: #f4f4f4;
  border-radius: 12px;
  font-family: Arial, sans-serif;
}

.container {
  background: white;
  padding: 20px;
  border-radius: 12px;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
  width: 100%;
  max-width: 400px;
  text-align: center;
}

h1 {
  font-size: 22px;
  margin-bottom: 15px;
  color: #333;
}

label {
  font-size: 15px;
  font-weight: bold;
  display: block;
  margin-top: 10px;
  text-align: left;
  color: #333;
}

select {
  width: 100%;
  padding: 10px;
  font-size: 16px;
  margin-top: 5px;
  border: 1px solid #ccc;
  border-radius: 8px;
  background: #f9f9f9;
  outline: none;
}

select:focus {
  border-color: #3b82f6;
}

#score {
  margin-top: 20px;
  font-size: 20px;
  font-weight: bold;
  color: #333;
  padding: 10px;
  border-radius: 8px;
  background: #e3f2fd;
  transition: background 0.3s, color 0.3s;
}

.priority-Low { background: #ffebee !important; color: #d32f2f !important; }
.priority-Medium { background: #fff3e0 !important; color: #f57c00 !important; }
.priority-High { background: #e8f5e9 !important; color: #388e3c !important; }

.info {
  margin-top: 20px;
  font-size: 14px;
  text-align: left;
  background: #f9f9f9;
  padding: 12px;
  border-radius: 8px;
  color: #555;
  line-height: 1.5;
}

.info p { margin-bottom: 5px; }
.info p:last-child { margin-bottom: 0; }
.info strong { display: block; color: #333; margin-bottom: 2px; }
</style>

<style>
html[data-theme="dark"] .calculator-wrapper { background: transparent !important; }
html[data-theme="dark"] .calculator-wrapper .container { background: #1e293b !important; box-shadow: 0 4px 6px rgba(0,0,0,0.3) !important; border: 1px solid #334155; }
html[data-theme="dark"] .calculator-wrapper h1,
html[data-theme="dark"] .calculator-wrapper label { color: #f1f5f9 !important; }
html[data-theme="dark"] .calculator-wrapper select { background: #0f172a !important; color: #f1f5f9 !important; border-color: #334155 !important; }
html[data-theme="dark"] .calculator-wrapper .info { background: #0f172a !important; color: #94a3b8 !important; border: 1px solid #334155; }
html[data-theme="dark"] .calculator-wrapper .info strong { color: #cbd5e1 !important; }


html[data-theme="dark"] .calculator-wrapper .priority-Low { background: rgba(239, 68, 68, 0.1) !important; color: #f87171 !important; border: 1px solid rgba(239, 68, 68, 0.2); }
html[data-theme="dark"] .calculator-wrapper .priority-Medium { background: rgba(245, 158, 11, 0.1) !important; color: #fbbf24 !important; border: 1px solid rgba(245, 158, 11, 0.2); }
html[data-theme="dark"] .calculator-wrapper .priority-High { background: rgba(16, 185, 129, 0.1) !important; color: #34d399 !important; border: 1px solid rgba(16, 185, 129, 0.2); }
</style>