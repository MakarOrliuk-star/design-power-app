# 1. Используем легкую версию Python 3.11
FROM python:3.11-slim

# 2. Создаем рабочую папку внутри сервера
WORKDIR /app

# 3. Копируем файл с библиотеками и устанавливаем их
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. Копируем все остальные файлы (питоновские скрипты)
COPY . .

# 5. Запускаем FastAPI сервер (Railway сам подставит нужный порт)
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}