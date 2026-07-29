import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { Queue } from "bullmq";
import { SMS_QUEUE, getBullConnection } from "../queues/index.js";
import { env } from "../env.js";

const DEFAULT_ALLOWED_COUNTRIES = [
  "albania", "australia", "austria", "belgium", "bosnia and herzegovina",
  "brazil", "bulgaria", "canada", "croatia", "czech republic", "denmark",
  "estonia", "finland", "france", "germany", "greece", "hungary", "ireland",
  "italy", "luxembourg", "montenegro", "netherlands", "new zealand",
  "north macedonia", "norway", "poland", "portugal", "romania", "serbia",
  "slovakia", "slovenia", "south korea", "spain", "sweden", "switzerland",
  "united kingdom"
];

// Initialize the order for worker to process
const smsQueue = new Queue(SMS_QUEUE, { connection: getBullConnection() });

export const smsRouter = Router();

// Validating request body from frontend
const smsBatchSchema = z.object({
  provider: z.enum(["dm", "miatel", "fortytwo", "messagewhiz"]),
  dmTokenKey: z.string().optional(),
  senderId: z.string().max(11).default("Info"),
  targets: z.array(
    z.object({
      mcc: z.string(),
      mnc: z.string(),
      country: z.string(),
      network: z.string(),
      language: z.string(),
    })
  ).min(1, "Необходимо выбрать хотя бы одну сеть"),
});

/**
 * POST /api/sms/batch
 * Запуск новой SMS-кампании
 */
smsRouter.post("/batch", async (req: Request, res: Response) => {
  try {
    const data = smsBatchSchema.parse(req.body);
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: "Пользователь не авторизован" });
      return;
    }

    const campaign = await prisma.smsCampaign.create({
      data: {
        userId,
        provider: data.provider,
        status: "pending",
        stats: {
          total: data.targets.length,
          sent: 0,
          delivered: 0,
          failed: 0,
        },
      },
    });

    await smsQueue.add("send-batch", {
      campaignId: campaign.id,
      userId,
      provider: data.provider,
      dmTokenKey: data.dmTokenKey,
      senderId: data.senderId,
      targets: data.targets,
    });

    res.status(201).json({
      success: true,
      campaignId: campaign.id,
      message: "Кампания успешно создана и отправлена в очередь",
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, errors: error.errors });
      return;
    }
    console.error("❌ SMS Batch Route Error:", error);
    res.status(500).json({ success: false, error: "Внутренняя ошибка сервера" });
  }
});

/**
 * GET /api/sms/campaign/:id
 * Поллинг статуса кампании для фронтенда
 */
smsRouter.get("/campaign/:id", async (req: Request, res: Response) => {
  try {
    const rawId = req.params.id;

    if (!rawId || typeof rawId !== "string") {
      res.status(400).json({ success: false, error: "Некорректный формат ID кампании" });
      return;
    }

    const campaignId: string = rawId;
    const userId = (req as any).user?.id;

    const campaign = await prisma.smsCampaign.findUnique({
      where: { id: campaignId },
      include: {
        messages: {
          select: {
            id: true,
            status: true,
            mcc: true,
            mnc: true,
            phoneNumber: true,
            senderId: true,
            messageBody: true,
            latency: true,
            errorLog: true,
            sentAt: true,
          },
        },
      },
    });

    if (!campaign) {
      res.status(404).json({ success: false, error: "Кампания не найдена" });
      return;
    }

    if (campaign.userId !== userId) {
      res.status(403).json({ success: false, error: "Доступ запрещен" });
      return;
    }

    res.json({ success: true, campaign });
  } catch (error) {
    console.error("❌ SMS Status Route Error:", error);
    res.status(500).json({ success: false, error: "Внутренняя ошибка сервера" });
  }
});

/**
 * GET /api/sms/networks
 * Получение сетей из TelQ с ФИЛЬТРАЦИЕЙ по 36 странам (+ динамические страны из БД)
 */
smsRouter.get("/networks", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    // 1. Собираем уникальные страны из базы данных Prisma (если они там заведены)
    let userTemplates = userId
      ? await prisma.smsTemplate.findMany({
          where: { userId },
          select: { country: true },
          distinct: ["country"],
        })
      : [];

    let dbCountries = userTemplates.map((t) => t.country.trim().toLowerCase());

    if (dbCountries.length === 0) {
      const allTemplates = await prisma.smsTemplate.findMany({
        select: { country: true },
        distinct: ["country"],
      });
      dbCountries = allTemplates.map((t) => t.country.trim().toLowerCase());
    }

    // Объединяем базовые 36 стран и всё, что уже сохранено в БД
    const allowedSet = new Set([
      ...DEFAULT_ALLOWED_COUNTRIES,
      ...dbCountries,
    ]);

    // 2. Авторизация в TelQ
    const appId = env.TELQ_APP_ID || "";
    const appKey = env.TELQ_APP_KEY || "";
    const numericAppId = /^\d+$/.test(appId) ? parseInt(appId, 10) : appId;

    const tokenRes = await fetch(`${env.TELQ_API_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: numericAppId, appKey }),
    });

    if (!tokenRes.ok) {
      res.status(500).json({ success: false, error: "Не удалось авторизоваться в TelQ" });
      return;
    }

    const tokenData: any = await tokenRes.json();
    const token = tokenData.value || tokenData.token;

    // 3. Загрузка сетей из TelQ
    const netRes = await fetch(`${env.TELQ_API_URL}/networks`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const netData: any = await netRes.json();
    const networks: any[] = Array.isArray(netData) ? netData : netData.data || [];

    // 4. Оставляем только те операторы, страны которых входят в allowedSet
    const filteredNetworks = networks.filter((net: any) => {
      const countryName = (net.countryName || net.country || "").trim().toLowerCase();
      return countryName && allowedSet.has(countryName);
    });

    res.json({ success: true, data: filteredNetworks });
  } catch (error: any) {
    console.error("❌ Networks Route Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/sms/history
 * Просмотр истории запущенных кампаний
 */
smsRouter.get("/history", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: "Не авторизован" });
      return;
    }

    const campaigns = await prisma.smsCampaign.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        _count: { select: { messages: true } },
      },
    });

    res.json({ success: true, campaigns });
  } catch (error: any) {
    console.error("❌ SMS History Error:", error);
    res.status(500).json({ success: false, error: "Ошибка получения истории" });
  }
});

// Схема валидации для сохранения шаблона
const templateSchema = z.object({
  country: z.string().min(1),
  language: z.string().min(1),
  body: z.string().min(1, "Текст сообщения не может быть пустым"),
  isDefault: z.boolean().default(false),
  mnc: z.string().optional(),
});

/**
 * GET /api/sms/templates
 * Получение всех шаблонов текущего пользователя
 */
smsRouter.get("/templates", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: "Не авторизован" });
      return;
    }

    const templates = await prisma.smsTemplate.findMany({
      where: { userId },
      orderBy: { country: "asc" },
    });

    res.json({ success: true, templates });
  } catch (error: any) {
    console.error("❌ Get Templates Error:", error);
    res.status(500).json({ success: false, error: "Ошибка при получении шаблонов" });
  }
});

/**
 * POST /api/sms/templates/mapping
 * Получение шаблонов, сгруппированных по выбранным странам (для Шага 2)
 */
smsRouter.post("/templates/mapping", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const { countries } = req.body as { countries: string[] };

    if (!Array.isArray(countries)) {
      res.status(400).json({ success: false, error: "Некорректный формат списка стран" });
      return;
    }

    const templates = await prisma.smsTemplate.findMany({
      where: {
        userId,
        country: { in: countries },
      },
    });

    const mapping: Record<string, typeof templates> = {};
    for (const c of countries) {
      mapping[c] = templates.filter((t) => t.country === c);
    }

    res.json({ success: true, data: mapping });
  } catch (error: any) {
    console.error("❌ Template Mapping Error:", error);
    res.status(500).json({ success: false, error: "Ошибка сопоставления шаблонов" });
  }
});

/**
 * POST /api/sms/templates
 * Создание или обновление (Upsert) шаблона
 */
smsRouter.post("/templates", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: "Не авторизован" });
      return;
    }

    const data = templateSchema.parse(req.body);
    const mncValue = data.mnc ?? null;

    const template = await prisma.smsTemplate.upsert({
      where: {
        userId_country_language: {
          userId,
          country: data.country,
          language: data.language,
        },
      },
      update: {
        body: data.body,
        isDefault: data.isDefault,
        mnc: mncValue,
      },
      create: {
        userId,
        country: data.country,
        language: data.language,
        body: data.body,
        isDefault: data.isDefault,
        mnc: mncValue,
      },
    });

    res.json({ success: true, template });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, errors: error.errors });
      return;
    }
    console.error("❌ Save Template Error:", error);
    res.status(500).json({ success: false, error: "Не удалось сохранить шаблон" });
  }
});