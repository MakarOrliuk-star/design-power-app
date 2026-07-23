FROM python:3.11-slim

WORKDIR /app

# Копируем списки зависимостей
COPY requirements.txt .

# Устанавливаем Python-пакеты
RUN pip install --no-cache-dir -r requirements.txt

# Команда playwright install-deps сама установит все необходимые пакеты системного уровня в Debian
RUN playwright install-deps chromium && playwright install chromium

# Копируем остальные файлы проекта
COPY . .

# Запускаем приложение
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]