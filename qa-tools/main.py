import os
import requests
import streamlit as st
import extra_streamlit_components as stx
from dotenv import load_dotenv

# 1. ЗАГРУЖАЕМ ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ
load_dotenv()
SYSTEM_DOMAIN = os.getenv("SYSTEM_DOMAIN")
SYSTEM_NAME = os.getenv("SYSTEM_NAME", "CRM")

if not SYSTEM_DOMAIN:
    st.error("❌ Критическая ошибка: переменная SYSTEM_DOMAIN не найдена в файле .env!")
    st.stop()

# ИМПОРТ МОДУЛЕЙ
import single_report
import mass_report
import brands_audit

st.set_page_config(page_title=f"{SYSTEM_NAME} Tools", layout="wide")

st.markdown("""
<style>
    /* 👇 УБИРАЕМ СТАНДАРТНЫЙ ИНТЕРФЕЙС STREAMLIT 👇 */
    header {visibility: hidden;} /* Скрываем верхнюю панель полностью */
    #MainMenu {visibility: hidden;} /* Скрываем шестеренку/бургер-меню */
    .stDeployButton {display: none;} /* Точечно убиваем кнопку Deploy */
    footer {visibility: hidden;} /* Скрываем подвал "Made with Streamlit" */
    
    /* Твой стиль для большой кнопки скачивания */
    div[data-testid="stDownloadButton"] button {
        height: 75px !important; border-radius: 12px !important;
        background: linear-gradient(135deg, #10b981, #059669) !important;
        color: white !important; font-size: 22px !important; font-weight: 800 !important;
    }
</style>
""", unsafe_allow_html=True)

cookie_manager = stx.CookieManager(key="cookie_manager")

# 1. ЖДЕМ ЗАГРУЗКИ: Если cookies еще None, значит браузер их не отдал
cookies = cookie_manager.get_all()
if cookies is None: 
    st.stop()

# 2. ИДЕАЛЬНАЯ СИНХРОНИЗАЦИЯ (Защита от запоздалых кук при F5)
for env in ["env2", "env5", "env7"]:
    session_key = f"token_{env}"
    cookie_name = f"system_token_{env}"
    del_flag = f"deleted_{env}"
    
    val_from_cookie = cookie_manager.get(cookie_name)
    
    # 1. Если только зашли на сайт, инициализируем память
    if session_key not in st.session_state:
        st.session_state[session_key] = val_from_cookie if val_from_cookie else ""
        
    # 2. Если кука долетела с задержкой (после F5), а в памяти пусто
    # И при этом юзер НЕ нажимал кнопку удаления в этой сессии
    if val_from_cookie and not st.session_state[session_key]:
        if not st.session_state.get(del_flag):
            st.session_state[session_key] = val_from_cookie

# 3. ФУНКЦИИ УПРАВЛЕНИЯ КЛЮЧАМИ
def reset_token(env_name):
    # Мгновенно затираем токен
    st.session_state[f"token_{env_name}"] = ""
    # Ставим флаг, что мы сами удалили куку (чтобы скрипт не восстановил её)
    st.session_state[f"deleted_{env_name}"] = True 
    cookie_manager.delete(f"system_token_{env_name}")

def save_token(env_name):
    new_token = st.session_state.get(f"input_{env_name}", "").strip()
    if new_token:
        # Сохраняем в память
        st.session_state[f"token_{env_name}"] = new_token
        # Снимаем флаг удаления
        st.session_state[f"deleted_{env_name}"] = False 
        # Даем браузеру команду сохранить куку на 30 дней
        cookie_manager.set(f"system_token_{env_name}", new_token, max_age=172800)

st.sidebar.title("🚀 QA tools")
app_mode = st.sidebar.radio("Выберите инструмент:", ["🗺️ Одиночный аудит", "🕵️‍♂️ Массовый аудит", "🏷️ Brands"])

st.sidebar.write("---")
st.sidebar.markdown("### 🔑 Статус авторизации")

# 4. ЖИВОЙ ПИНГАТОР (Без кэша! Всегда актуальные данные)
def verify_token_live(env_name, token):
    """Пингует API в реальном времени."""
    if not token or str(token).strip() == "":
        return "EMPTY"
        
    host_map = {
        "env2": f"boapi.{SYSTEM_DOMAIN}",
        "env5": f"boapi5.{SYSTEM_DOMAIN}",
        "env7": f"boapi7.{SYSTEM_DOMAIN}"
    }
    host = host_map.get(env_name, f"boapi.{SYSTEM_DOMAIN}")
    
    headers = {
        "accept": "application/json",
        "authorization": token,
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    }
    
    try:
        # Таймаут 3 секунды, чтобы интерфейс не зависал, если API недоступно
        res = requests.get(f"https://{host}/api/users/me", headers=headers, timeout=3)
        
        # Если API четко говорит "Не авторизован" - токен протух
        if res.status_code in [401, 403]:
            return "EXPIRED"
        else:
            # 200 OK или другая ошибка параметров = токен живой
            return "OK"
            
    except Exception as e:
        print(f"[PING ERROR] Ошибка связи с {host}: {e}")
        return "ERROR"

env_labels = {
    "env2": "2 Окружение",
    "env5": "5 Окружение",
    "env7": "7 Окружение"
}

# 5. ОТРИСОВКА БОКОВОГО МЕНЮ И МГНОВЕННАЯ ПРОВЕРКА
for env_key, label in env_labels.items():
    current_token = st.session_state.get(f"token_{env_key}", "")
    
    # Отправляем текущий токен на проверку прямо сейчас
    status = verify_token_live(env_key, current_token)
    
    if status == "OK":
        col1, col2 = st.sidebar.columns([0.75, 0.25])
        col1.success(f"✅ {label}")
        col2.button("✖️", key=f"reset_{env_key}", on_click=reset_token, args=(env_key,))
        
    elif status == "EXPIRED":
        # 🚨 ТОКЕН ПРОТУХ ЗА НОЧЬ: Принудительно очищаем память, чтобы код не падал
        st.session_state[f"token_{env_key}"] = ""
        
        st.sidebar.error(f"❌ {label} (Токен истек!)")
        st.sidebar.text_input("Обновите Token:", type="password", key=f"input_{env_key}")
        st.sidebar.button("💾 Обновить", key=f"save_{env_key}", on_click=save_token, args=(env_key,))
        
    elif status == "ERROR": 
        # API лежит или нет интернета
        col1, col2 = st.sidebar.columns([0.75, 0.25])
        col1.warning(f"⚠️ {label} (Нет связи)")
        col2.button("✖️", key=f"reset_err_{env_key}", on_click=reset_token, args=(env_key,))
        
    else: 
        # EMPTY - Токена нет
        st.sidebar.error(f"❌ {label}")
        st.sidebar.text_input(f"Token для {env_key}:", type="password", key=f"input_{env_key}")
        st.sidebar.button("💾 Сохранить", key=f"save_{env_key}", on_click=save_token, args=(env_key,))

# 6. МАРШРУТИЗАЦИЯ МОДУЛЕЙ
if app_mode == "🗺️ Одиночный аудит":
    single_report.run_module(cookie_manager)
elif app_mode == "🕵️‍♂️ Массовый аудит":
    mass_report.run_module(cookie_manager)
elif app_mode == "🏷️ Brands":
    brands_audit.run_module(cookie_manager)