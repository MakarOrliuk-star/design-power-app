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

const DEFAULT_DICTIONARY: Record<string, { language: string; isDefault: boolean }[]> = {
  "Albania": [
    { language: "SQ", isDefault: true },
    { language: "EN", isDefault: false }
  ],
  "Australia": [
    { language: "EN", isDefault: true }
  ],
  "Austria": [
    { language: "DE", isDefault: true }
  ],
  "Belgium": [
    { language: "FR", isDefault: true },
    { language: "EN", isDefault: false }
  ],
  "Bosnia and Herzegovina": [
    { language: "BS", isDefault: true }
  ],
  "Brazil": [
    { language: "BR", isDefault: true },
    { language: "PT", isDefault: false }
  ],
  "Bulgaria": [
    { language: "BG", isDefault: true }
  ],
  "Canada": [
    { language: "EN", isDefault: true },
    { language: "FR", isDefault: false }
  ],
  "Croatia": [
    { language: "HR", isDefault: true }
  ],
  "Czech Republic": [
    { language: "CS", isDefault: true }
  ],
  "Denmark": [
    { language: "DA", isDefault: true }
  ],
  "Estonia": [
    { language: "ET", isDefault: true }
  ],
  "Finland": [
    { language: "FI", isDefault: true }
  ],
  "France": [
    { language: "FR", isDefault: true }
  ],
  "Germany": [
    { language: "DE", isDefault: true }
  ],
  "Greece": [
    { language: "EN", isDefault: true },
    { language: "EL", isDefault: false }
  ],
  "Hungary": [
    { language: "HU", isDefault: true }
  ],
  "Ireland": [
    { language: "EN", isDefault: true }
  ],
  "Italy": [
    { language: "IT", isDefault: true }
  ],
  "Luxembourg": [
    { language: "FR", isDefault: true },
    { language: "PT", isDefault: false }
  ],
  "North Macedonia": [
    { language: "MK", isDefault: true },
    { language: "EN", isDefault: false }
  ],
  "Montenegro": [
    { language: "SR", isDefault: true }
  ],
  "Netherlands": [
    { language: "EN", isDefault: true }
  ],
  "New Zealand": [
    { language: "EN", isDefault: true }
  ],
  "Norway": [
    { language: "NO", isDefault: true }
  ],
  "Poland": [
    { language: "PL", isDefault: true }
  ],
  "Portugal": [
    { language: "PT", isDefault: true }
  ],
  "Romania": [
    { language: "RO", isDefault: true }
  ],
  "Serbia": [
    { language: "SR", isDefault: true }
  ],
  "Slovakia": [
    { language: "SK", isDefault: true }
  ],
  "Slovenia": [
    { language: "SL", isDefault: true }
  ],
  "South Korea": [
    { language: "KO", isDefault: true }
  ],
  "Spain": [
    { language: "ES", isDefault: true }
  ],
  "Sweden": [
    { language: "EN", isDefault: true }
  ],
  "Switzerland": [
    { language: "DE", isDefault: true },
    { language: "EN", isDefault: false }
  ],
  "United Kingdom": [
    { language: "EN", isDefault: true }
  ]
};

function getDefaultLanguagesForCountry(countryName: string) {
  const norm = countryName.trim().toLowerCase();
  for (const [key, langs] of Object.entries(DEFAULT_DICTIONARY)) {
    if (key.trim().toLowerCase() === norm) {
      return langs;
    }
  }
  return [{ language: "EN", isDefault: true }];
}

// Инициализируем очередь для отправки задач воркеру
const smsQueue = new Queue(SMS_QUEUE, { connection: getBullConnection() });

export const smsRouter = Router();

// Схема валидации входящего тела запроса от Vue-фронтенда
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
 * Получение сетей из TelQ с ФИЛЬТРАЦИЕЙ по 36 странам
 */
smsRouter.get("/networks", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

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

    const allowedSet = new Set([
      ...DEFAULT_ALLOWED_COUNTRIES,
      ...dbCountries,
    ]);

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

    const netRes = await fetch(`${env.TELQ_API_URL}/networks`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const netData: any = await netRes.json();
    const networks: any[] = Array.isArray(netData) ? netData : netData.data || [];

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

/**
 * POST /api/sms/templates/mapping
 * Получение шаблонов с подстановкой дефолтного словаря языков
 */
smsRouter.post("/templates/mapping", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const { countries } = req.body as { countries: string[] };

    if (!Array.isArray(countries)) {
      res.status(400).json({ success: false, error: "Некорректный формат списка стран" });
      return;
    }

    const dbTemplates = userId
      ? await prisma.smsTemplate.findMany({
          where: {
            userId,
            country: { in: countries },
          },
        })
      : [];

    const mapping: Record<string, any[]> = {};

    for (const country of countries) {
      const userCountryTemplates = dbTemplates.filter(
        (t) => t.country.trim().toLowerCase() === country.trim().toLowerCase()
      );

      if (userCountryTemplates.length > 0) {
        mapping[country] = userCountryTemplates;
      } else {
        const defaultLangs = getDefaultLanguagesForCountry(country);
        mapping[country] = defaultLangs.map((item) => ({
          country,
          language: item.language,
          body: "Code: [[TOKEN]]",
          isDefault: item.isDefault,
        }));
      }
    }

    res.json({ success: true, data: mapping });
  } catch (error: any) {
    console.error("❌ Template Mapping Error:", error);
    res.status(500).json({ success: false, error: "Ошибка сопоставления шаблонов" });
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