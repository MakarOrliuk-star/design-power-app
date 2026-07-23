import { Router } from "express";
import type { Request, Response } from "express";

export const qatoolsRouter: Router = Router();

// Адрес запущенного локально (или в Railway) Python-воркера
const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://127.0.0.1:8000";

/**
 * Хелпер 1: Проксирование обычных JSON-запросов (Модуль Brands)
 */
async function proxyJson(req: Request, res: Response, pythonPath: string) {
  try {
    const response = await fetch(`${PYTHON_API_URL}${pythonPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error(`[Proxy JSON Error] ${pythonPath}:`, error);
    res.status(500).json({ error: "Внутренняя ошибка соединения с Python-сервисом" });
  }
}

/**
 * Хелпер 2: Проксирование потокового вещания SSE (Модули Аудита)
 */
async function proxyStream(req: Request, res: Response, pythonPath: string) {
  try {
    const response = await fetch(`${PYTHON_API_URL}${pythonPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    if (!response.ok || !response.body) {
      const err = await response.text();
      res.status(response.status).json({ error: err || "Ошибка Python-сервиса" });
      return;
    }

    // Настраиваем Express для трансляции потока браузеру
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    
    res.end();
  } catch (error) {
    console.error(`[Proxy Stream Error] ${pythonPath}:`, error);
    res.status(500).json({ error: "Внутренняя ошибка трансляции потока" });
  }
}

// ==========================================
// 🚀 ЭНДПОИНТЫ ДЛЯ ФРОНТЕНДА
// ==========================================

// 1. Стриминговые маршруты (Отчеты генерируются в реальном времени)
qatoolsRouter.post("/single-audit", (req, res) => proxyStream(req, res, "/api/single-report/generate"));
qatoolsRouter.post("/mass-audit", (req, res) => proxyStream(req, res, "/api/mass-report/generate"));

// 2. Обычные маршруты (Brands & Labels)
qatoolsRouter.post("/brands/search-campaigns", (req, res) => proxyJson(req, res, "/api/brands/search-campaigns"));
qatoolsRouter.post("/brands/bulk-labels", (req, res) => proxyJson(req, res, "/api/brands/bulk-labels"));
qatoolsRouter.post("/brands/resolve-links", (req, res) => proxyJson(req, res, "/api/brands/resolve-links"));
qatoolsRouter.post("/backoffice-audit", (req, res) => proxyStream(req, res, "/api/backoffice-audit"));