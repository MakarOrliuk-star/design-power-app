import os
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from bo_auditor import run_backoffice_stream, BackofficeAuditRequest
from pydantic import BaseModel

# 1. ИМПОРТ МОДУЛЕЙ
try:
    import single_report
    import mass_report
    import brands_audit
except ImportError as e:
    print(f"[WARNING] Ошибка импорта модуля: {e}")

# 2. ЗАГРУЖАЕМ ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ
load_dotenv()
SYSTEM_DOMAIN = os.getenv("SYSTEM_DOMAIN")
SYSTEM_NAME = os.getenv("SYSTEM_NAME", "CRM")

if not SYSTEM_DOMAIN:
    raise RuntimeError("❌ Критическая ошибка: переменная SYSTEM_DOMAIN не найдена в файле .env!")

# 3. ИНИЦИАЛИЗАЦИЯ FASTAPI
app = FastAPI(
    title=f"{SYSTEM_NAME} Tools API",
    description="Микросервис для аудита кампаний и проверки токенов",
)

# 🚨 БЛОК НАСТРОЙКИ CORS ЗАЩИТЫ:
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # В продакшене лучше указать конкретные домены, например ["https://your-hub.com"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 4. PYDANTIC СХЕМЫ (Валидация данных)
class TokenVerifyRequest(BaseModel):
    env_name: str
    token: str
    
    class Config:
        json_schema_extra = {
            "example": {"env_name": "env2", "token": "Bearer your-token"}
        }

class TokenVerifyResponse(BaseModel):
    status: str  # "OK", "EXPIRED", "ERROR", "EMPTY"

# 5. ЭНДПОИНТЫ

@app.get("/health")
def health_check():
    """Проверка доступности микросервиса."""
    return {"status": "ok", "system_name": SYSTEM_NAME, "domain": SYSTEM_DOMAIN}

@app.post("/api/backoffice-audit")
async def backoffice_audit_endpoint(payload: BackofficeAuditRequest):
    return StreamingResponse(run_backoffice_stream(payload), media_type="text/event-stream")

@app.post("/api/verify-token", response_model=TokenVerifyResponse)
def verify_token_live(request: TokenVerifyRequest):
    """
    Пингует API CRM в реальном времени.
    Возвращает статус токена для обновления интерфейса на стороне Nuxt.
    """
    token = request.token
    env_name = request.env_name

    if not token or str(token).strip() == "":
        return TokenVerifyResponse(status="EMPTY")
        
    host_map = {
        "env2": f"boapi.{SYSTEM_DOMAIN}",
        "env5": f"boapi5.{SYSTEM_DOMAIN}",
        "env7": f"boapi7.{SYSTEM_DOMAIN}"
    }
    
    # Если окружение не найдено в маппинге, по умолчанию используем prod (boapi)
    host = host_map.get(env_name, f"boapi.{SYSTEM_DOMAIN}")
    
    headers = {
        "accept": "application/json",
        "authorization": token,
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    }
    
    try:
        # Таймаут 3 секунды, чтобы запрос не висел, если API недоступно
        res = requests.get(f"https://{host}/api/users/me", headers=headers, timeout=3)
        
        # Если API четко говорит "Не авторизован" - токен протух
        if res.status_code in [401, 403]:
            return TokenVerifyResponse(status="EXPIRED")
        else:
            # 200 OK или другая ошибка параметров = токен живой
            return TokenVerifyResponse(status="OK")
            
    except Exception as e:
        print(f"[PING ERROR] Ошибка связи с {host}: {e}")
        return TokenVerifyResponse(status="ERROR")

# Подключение роутеров из других модулей:
try:
    app.include_router(single_report.router, prefix="/api/single-report")
    app.include_router(mass_report.router, prefix="/api/mass-report")
    app.include_router(brands_audit.router, prefix="/api/brands")
except NameError:
    pass # Игнорируем ошибку, если модули не загрузились из-за старого кода