import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";

export const exportSmsRouter = Router();

function generateReportCsv(campaign: any): string {
  const stats: Record<string, { country: string; provider: string; sent: number; delivered: number }> = {};
  const timestamp = new Date(campaign.createdAt).toLocaleString("ru-RU", { timeZone: "UTC" });

  for (const msg of campaign.messages) {
    const country = msg.country || "Unknown";
    const provider = campaign.provider || "Unknown";
    const key = `${country}|${provider}`;

    if (!stats[key]) {
      stats[key] = {
        country,
        provider: getPrettyProviderName(provider),
        sent: 0,
        delivered: 0,
      };
    }

    if (msg.sentAt) {
      stats[key].sent++;
    }

    const status = (msg.status || "").toUpperCase();
    if (status === "RECEIVED" || status === "POSITIVE") {
      stats[key].delivered++;
    }
  }

  const headers = ["Country", "Provider", "Date & Time", "Sent", "Delivered", "Delivery Rate"];
  const rows = Object.values(stats).map((item) => {
    const rate = item.sent > 0 ? (item.delivered / item.sent) * 100 : 0;
    return [
      `"${item.country}"`,
      `"${item.provider}"`,
      `"${timestamp}"`,
      item.sent,
      item.delivered,
      `"${rate.toFixed(2)}%"`,
    ];
  });

  return [headers.join(";"), ...rows.map((r) => r.join(";"))].join("\n");
}

function getPrettyProviderName(provider: string): string {
  const p = provider.toLowerCase();
  if (p === "miatel") return "Miatel";
  if (p === "fortytwo") return "FortyTwo";
  if (p === "messagewhiz") return "MessageWhiz";
  if (p === "dm") return "Dynamic Messaging";
  return provider;
}

exportSmsRouter.post("/server/:campaignId", async (req: Request, res: Response) => {
  try {
    const campaignId = req.params.campaignId;

    if (!campaignId || typeof campaignId !== "string") {
      res.status(400).json({ success: false, error: "Некорректный ID кампании" });
      return;
    }

    const exportServerUrl = (process.env.EXPORT_SERVER_URL || "").replace(/\/$/, "");
    if (!exportServerUrl) {
      res.status(500).json({
        success: false,
        error: "EXPORT_SERVER_URL не настроен в переменных окружения",
      });
      return;
    }

    const authSecret = process.env.NGINX_AUTH || "";

    const campaign = await prisma.smsCampaign.findUnique({
      where: { id: campaignId },
      include: { messages: true },
    });

    if (!campaign) {
      res.status(404).json({ success: false, error: "Кампания не найдена" });
      return;
    }

    const csvContent = generateReportCsv(campaign);
    const fileName = `report_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    
    const endpoint = exportServerUrl.includes("?")
      ? `${exportServerUrl}&filename=${fileName}`
      : `${exportServerUrl}?filename=${fileName}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/csv",
        Authorization: `Basic ${authSecret}`,
      },
      body: csvContent,
    });

    const resCode = response.status;

    if (resCode >= 200 && resCode < 300) {
      res.json({ success: true, code: resCode, message: "Отчет успешно отправлен на сервер" });
    } else {
      res.status(500).json({ success: false, code: resCode, error: `Ошибка сервера экспорта (${resCode})` });
    }
  } catch (error: any) {
    console.error("❌ Export Error:", error);
    res.status(500).json({ success: false, error: "Не удалось отправить отчет" });
  }
});

exportSmsRouter.get("/csv/:campaignId", async (req: Request, res: Response) => {
  try {
    const campaignId = req.params.campaignId;

    if (!campaignId || typeof campaignId !== "string") {
      res.status(400).json({ success: false, error: "Некорректный ID кампании" });
      return;
    }

    const campaign = await prisma.smsCampaign.findUnique({
      where: { id: campaignId },
      include: { messages: true },
    });

    if (!campaign) {
      res.status(404).json({ success: false, error: "Кампания не найдена" });
      return;
    }

    const csvContent = generateReportCsv(campaign);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="sms_report_${campaignId}.csv"`);
    res.status(200).send(csvContent);
  } catch (error: any) {
    console.error("❌ CSV Download Error:", error);
    res.status(500).json({ success: false, error: "Не удалось сгенерировать CSV" });
  }
});