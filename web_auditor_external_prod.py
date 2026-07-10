import time
import requests
import streamlit as st
import extra_streamlit_components as stx

# ИМПОРТ МОДУЛЕЙ
import web_auditor_app_external_prod
import monthly_report_app_external_prod
import web_auditor_external_brands

st.set_page_config(page_title="Smartico Tools", layout="wide")

st.markdown("""
<style>
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

# 2. НАДЕЖНАЯ СИНХРОНИЗАЦИЯ (с защитой от перезаписи пустыми строками)
for env in ["env2", "env5", "env7"]:
    cookie_name = f"smartico_token_{env}"
    session_key = f"token_{env}"
    
    # Пытаемся достать значение из куки
    val_from_cookie = cookie_manager.get(cookie_name)
    
    # Если в памяти (session_state) пусто, а в куки значение ЕСТЬ — перекладываем из куки в память
    if session_key not in st.session_state or not st.session_state[session_key]:
        if val_from_cookie:
            st.session_state[session_key] = val_from_cookie
        else:
            st.session_state[session_key] = ""

# 3. ФУНКЦИИ УПРАВЛЕНИЯ КЛЮЧАМИ (Через on_click)
def reset_token(env_name):
    st.session_state[f"token_{env_name}"] = ""
    cookie_manager.delete(f"smartico_token_{env_name}")
    # Ждем долю секунды, чтобы браузер точно удалил куки, и перегружаем страницу
    time.sleep(0.2)
    st.rerun()

def save_token(env_name):
    # Достаем значение из поля ввода
    new_token = st.session_state.get(f"input_{env_name}", "")
    if new_token:
        st.session_state[f"token_{env_name}"] = new_token
        # Сохраняем в куки на месяц (2592000 секунд)
        cookie_manager.set(f"smartico_token_{env_name}", new_token, max_age=2592000)
        # Такая же пауза и релоад, как в работающем удалении
        time.sleep(0.2)
        st.rerun()

st.sidebar.title("🚀 QA tools")
app_mode = st.sidebar.radio("Выберите инструмент:", ["🗺️ Одиночный аудит", "🕵️‍♂️ Массовый аудит", "🏷️ Brands"])

st.sidebar.write("---")
st.sidebar.markdown("### 🔑 Статус авторизации")

# 👇 НОВЫЙ БЛОК ПИНГАТОРА 👇
@st.cache_data(ttl=300, show_spinner=False)
def verify_token(env_name, token):
    """Пингует API Smartico. Результат кэшируется на 5 минут."""
    if not token:
        return "EMPTY"
        
    host_map = {
        "env2": "boapi.smartico.ai",
        "env5": "boapi5.smartico.ai",
        "env7": "boapi7.smartico.ai"
    }
    host = host_map.get(env_name, "boapi.smartico.ai")
    
    headers = {
        "accept": "application/json",
        "authorization": token,
        # 🚨 ФИКС: Маскируемся под браузер, чтобы Cloudflare не блокировал запрос
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    }
    
    try:
        # Проверяем доступ к базовому эндпоинту юзера (он самый легкий)
        res = requests.get(f"https://{host}/api/users/me", headers=headers, timeout=5)
        
        # Если API четко говорит "Не авторизован" - токен протух
        if res.status_code in [401, 403]:
            return "EXPIRED"
        # Если получаем 200 OK - всё супер
        elif res.status_code == 200:
            return "OK"
        # Если получаем любую другую ошибку (например 400), значит токен сервер принял,
        # но ему не хватило параметров. Считаем, что токен живой.
        else:
            return "OK"
            
    except Exception as e:
        print(f"[PING ERROR] Ошибка связи с {host}: {e}")
        return "ERROR"
# 👆 ==================== 👆

env_labels = {
    "env2": "2 Окружение",
    "env5": "5 Окружение",
    "env7": "7 Окружение"
}

# 4. ОТРИСОВКА БОКОВОГО МЕНЮ И ДИНАМИЧЕСКАЯ ПРОВЕРКА
for env_key, label in env_labels.items():
    current_token = st.session_state.get(f"token_{env_key}", "")
    
    if current_token:
        # Отправляем токен на проверку (реальный запрос будет лишь 1 раз в 5 минут)
        status = verify_token(env_key, current_token)
        
        if status == "OK":
            col1, col2 = st.sidebar.columns([0.75, 0.25])
            col1.success(f"✅ {label}")
            col2.button("✖️", key=f"reset_{env_key}", on_click=reset_token, args=(env_key,))
            
        elif status == "EXPIRED":
            # 🚨 ТОКЕН ПРОТУХ: Обнуляем его локально!
            # Модули ниже увидят пустую строку и выведут штатную ошибку "Нет авторизации"
            st.session_state[f"token_{env_key}"] = ""
            
            st.sidebar.error(f"❌ {label} (Токен истек!)")
            st.sidebar.text_input(f"Обновите Token:", type="password", key=f"input_{env_key}")
            st.sidebar.button("💾 Обновить", key=f"save_{env_key}", on_click=save_token, args=(env_key,))
            
        else: # ERROR (Таймаут, нет интернета или Smartico лежит)
            col1, col2 = st.sidebar.columns([0.75, 0.25])
            col1.warning(f"⚠️ {label} (API не отвечает)")
            col2.button("✖️", key=f"reset_err_{env_key}", on_click=reset_token, args=(env_key,))
            
    else:
        st.sidebar.error(f"❌ {label}")
        st.sidebar.text_input(f"Token для {env_key}:", type="password", key=f"input_{env_key}")
        st.sidebar.button("💾 Сохранить", key=f"save_{env_key}", on_click=save_token, args=(env_key,))

# ==========================================
# 👇 КНОПКА СБРОСА КЭША 👇
# ==========================================
st.sidebar.markdown("---")
if st.sidebar.button("🔄 Обновить базу юзеров (Сбросить кэш)"):
    st.cache_data.clear() # Глобально очищает кэш юзеров
    st.sidebar.success("✅ База пользователей сброшена!")
    time.sleep(1) # Даем секунду прочитать сообщение
    st.rerun()    # Перезагружаем страницу для чистоты эксперимента
# ==========================================


# 5. МАРШРУТИЗАЦИЯ МОДУЛЕЙ
if app_mode == "🗺️ Одиночный аудит":
    web_auditor_app_external_prod.run_module(cookie_manager)
elif app_mode == "🕵️‍♂️ Массовый аудит":
    monthly_report_app_external_prod.run_module(cookie_manager)
elif app_mode == "🏷️ Brands":
    web_auditor_external_brands.run_module(cookie_manager)
