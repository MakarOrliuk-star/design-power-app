import { Router } from "express";

export const auditorRouter = Router();

auditorRouter.post("/stream", async (req, res) => {
  // 1. Устанавливаем заголовки для Server-Sent Events (SSE)
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  // Сбрасываем таймаут, так как аудит может длиться несколько минут
  req.setTimeout(0);

  try {
    // Берем URL из .env или используем локальный по умолчанию
    const pythonUrl = process.env.PYTHON_WORKER_URL || "http://localhost:8000/audit/stream";

    // 2. Стучимся к Python-воркеру, прокидывая тело запроса от фронтенда
    const response = await fetch(pythonUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    if (!response.ok || !response.body) {
      res.write(`data: ${JSON.stringify({ type: "error", msg: `Worker error: HTTP ${response.status}` })}\n\n`);
      return res.end();
    }

    // 3. Читаем поток от Питона "на лету" и сразу пишем во фронтенд
    // @ts-ignore - игнорируем ошибку TS, так как fetch встроен в Node 18+
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }

    res.end(); // Закрываем соединение при успехе
  } catch (error: any) {
    console.error("Audit Stream Error:", error);
    res.write(`data: ${JSON.stringify({ type: "error", msg: error.message || "Internal proxy error" })}\n\n`);
    res.end();
  }
});