# Используем легкую версию Python 3.11
FROM python:3.11-slim

# Устанавливаем системные утилиты Linux, нужные для скачивания браузера
RUN apt-get update && apt-get install -y wget gnupg curl && rm -rf /var/lib/apt/lists/*

# Создаем рабочую папку на сервере
WORKDIR /app

# Сначала копируем список библиотек и устанавливаем их
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Устанавливаем Chromium и все его системные зависимости (шрифты, графику)
RUN playwright install chromium
RUN playwright install-deps chromium

# Копируем все остальные файлы проекта (наши питон скрипты)
COPY . .

# Команда запуска Streamlit. 
# $PORT — это переменная, которую Railway выдает автоматически.
CMD ["sh", "-c", "streamlit run web_auditor_app_external_prod.py --server.port $PORT --server.address 0.0.0.0 --server.enableCORS false --server.enableXsrfProtection false"]