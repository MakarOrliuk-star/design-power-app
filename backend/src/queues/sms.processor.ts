import { Queue } from "bullmq";
import { prisma } from "../lib/prisma.js";
import { SMS_QUEUE, getBullConnection, type SmsBatchJobData } from "./index.js";

const smsQueue = new Queue(SMS_QUEUE, { connection: getBullConnection() });

export async function processSmsJob(jobData: SmsBatchJobData) {
  const { campaignId, userId, provider, dmTokenKey, senderId, targets } = jobData;

  console.log(`🚀 [SMS Campaign ${campaignId}] Старт обработки (${targets.length} сетей)`);

  try {
    await prisma.smsCampaign.update({
      where: { id: campaignId },
      data: { status: "processing" },
    });

    const telqToken = await getTelqToken();
    const reservedNumbers = await reserveTelqNumbers(telqToken, targets);

    const createdMessages = [];
    for (const item of reservedNumbers) {
      const msg = await prisma.smsMessage.create({
        data: {
          campaignId,
          testId: item.testId,
          phoneNumber: item.phoneNumber,
          mcc: item.mcc,
          mnc: item.mnc,
          country: item.country,
          network: item.network,
          senderId,
          status: item.testId ? "READY_TO_SEND" : "ERROR",
          errorLog: item.testId ? null : "TelQ: No number available",
        },
      });
      if (item.testId) createdMessages.push({ ...msg, language: item.language });
    }

    const templates = await prisma.smsTemplate.findMany({ where: { userId } });

    let sentCount = 0;
    let failedCount = 0;

    for (const msg of createdMessages) {
      const msgCountryNorm = (msg.country || "").trim().toLowerCase();
      const msgLangNorm = (msg.language || "").trim().toLowerCase();

      const userTemplate =
        templates.find(
          (t) =>
            t.country.trim().toLowerCase() === msgCountryNorm &&
            t.language.trim().toLowerCase() === msgLangNorm
        ) ||
        templates.find((t) => t.isDefault) ||
        { body: "Code: [[TOKEN]]" };

      const rawToken = msg.testId?.includes("|") ? msg.testId.split("|")[1] : msg.testId;
      const testToken = rawToken ?? "";

      let templateBody = userTemplate.body;
      if (!templateBody.includes("[[TOKEN]]")) {
        templateBody = `${templateBody.trim()} [[TOKEN]]`;
      }
      const fullMessageBody = templateBody.replace("[[TOKEN]]", testToken);

      await prisma.smsMessage.update({
        where: { id: msg.id },
        data: { messageBody: fullMessageBody },
      });

      const sendResult = await sendSMS({
        provider,
        phone: msg.phoneNumber,
        text: fullMessageBody,
        senderId,
        testId: msg.testId,
        ...(dmTokenKey ? { dmTokenKey } : {}),
      });

      if (sendResult.success) {
        sentCount++;
        await prisma.smsMessage.update({
          where: { id: msg.id },
          data: { status: "SENT", sentAt: new Date() },
        });
      } else {
        failedCount++;
        await prisma.smsMessage.update({
          where: { id: msg.id },
          data: { 
            status: "ERROR", 
            errorLog: sendResult.error || "Unknown send error" 
          },
        });
      }
    }

    // Обновляем статистику кампании
    await prisma.smsCampaign.update({
      where: { id: campaignId },
      data: {
        stats: {
          total: targets.length,
          sent: sentCount,
          delivered: 0,
          failed: failedCount,
        },
      },
    });

    console.log(`✅ [SMS Campaign ${campaignId}] Отправлено: ${sentCount}, Ошибок: ${failedCount}`);

    // Запускаем первый опрос статусов TelQ уже через 15 секунд
    if (sentCount > 0) {
      await smsQueue.add(
        "poll-status",
        { campaignId, attempt: 1 },
        { delay: 15 * 1000 }
      );
      console.log(`⏳ [SMS Campaign ${campaignId}] Запланирован опрос TelQ через 15 секунд.`);
    } else {
      await prisma.smsCampaign.update({
        where: { id: campaignId },
        data: { status: "completed" },
      });
    }
  } catch (error: any) {
    console.error(`❌ [SMS Campaign ${campaignId}] Critical Error:`, error);
    await prisma.smsCampaign.update({
      where: { id: campaignId },
      data: { status: "failed" },
    });
  }
}

/**
 * ПОЛЛИНГ ПРОЦЕССОР: Опрос статусов в TelQ
 */
export async function processSmsPollingJob(data: { campaignId: string; attempt: number }) {
  const { campaignId, attempt } = data;
  console.log(`🔍 [Polling Campaign ${campaignId}] Попытка #${attempt}...`);

  const campaign = await prisma.smsCampaign.findUnique({
    where: { id: campaignId },
    include: { messages: true },
  });

  if (!campaign || campaign.status === "completed" || campaign.status === "failed") return;

  const activeMessages = campaign.messages.filter((m) => m.status === "SENT" && m.testId);

  if (activeMessages.length === 0 || attempt >= 12) {
    for (const msg of activeMessages) {
      await prisma.smsMessage.update({
        where: { id: msg.id },
        data: { status: "EXPIRED" },
      });
    }

    const updatedMessages = await prisma.smsMessage.findMany({ where: { campaignId } });
    const delivered = updatedMessages.filter((m) => m.status === "RECEIVED" || m.status === "POSITIVE").length;
    const failed = updatedMessages.filter((m) => ["ERROR", "EXPIRED", "FAILED"].includes(m.status)).length;

    await prisma.smsCampaign.update({
      where: { id: campaignId },
      data: {
        status: "completed",
        stats: {
          total: updatedMessages.length,
          sent: updatedMessages.filter((m) => m.sentAt).length,
          delivered,
          failed,
        },
      },
    });

    console.log(`🏁 [SMS Campaign ${campaignId}] Поллинг завершен! Итого доставлено: ${delivered}/${updatedMessages.length}`);
    return;
  }

  try {
    const telqToken = await getTelqToken();

    for (const msg of activeMessages) {
      const numericId = msg.testId!.split("|")[0];
      const res = await fetch(`https://api.telqtele.com/v3/client/tests/${numericId}`, {
        headers: { Authorization: `Bearer ${telqToken}` },
      });

      if (res.ok) {
        const testData: any = await res.json();
        const receiptStatus = testData.receiptStatus || "WAIT";

        if (receiptStatus !== "WAIT") {
          await prisma.smsMessage.update({
            where: { id: msg.id },
            data: {
              status: receiptStatus,
              latency: testData.latency ? parseFloat(testData.latency) : null,
            },
          });
        }
      }
    }

    // Последующие опросы каждые 30 секунд
    await smsQueue.add(
      "poll-status",
      { campaignId, attempt: attempt + 1 },
      { delay: 30 * 1000 }
    );
  } catch (err) {
    console.error(`⚠️ [Polling Error Campaign ${campaignId}]:`, err);
  }
}

// ============================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (TelQ + Senders)
// ============================================================================

async function getTelqToken(): Promise<string> {
  const appId = process.env.TELQ_APP_ID || "";
  const appKey = process.env.TELQ_APP_KEY || "";
  const numericAppId = /^\d+$/.test(appId) ? parseInt(appId, 10) : appId;

  const res = await fetch("https://api.telqtele.com/v3/client/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: numericAppId, appKey }),
  });

  if (!res.ok) throw new Error(`TelQ Auth Failed: ${await res.text()}`);
  const data: any = await res.json();
  return data.value || data.token || data.accessToken;
}

async function reserveTelqNumbers(token: string, targets: SmsBatchJobData["targets"]) {
  const res = await fetch("https://api.telqtele.com/v3/client/tests", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      destinationNetworks: targets.map((t) => ({ mcc: t.mcc, mnc: t.mnc })),
    }),
  });

  if (!res.ok) throw new Error(`TelQ Batch Reserve Failed: ${await res.text()}`);
  const responseData: any = await res.json();
  const testList = Array.isArray(responseData) ? responseData : responseData.data || [];

  return targets.map((t) => {
    const matchIndex = testList.findIndex(
      (rt: any) =>
        rt.destinationNetwork &&
        String(rt.destinationNetwork.mcc) === String(t.mcc) &&
        String(rt.destinationNetwork.mnc) === String(t.mnc)
    );

    let match = null;
    if (matchIndex !== -1) {
      match = testList.splice(matchIndex, 1)[0];
    }

    return {
      country: t.country,
      network: t.network,
      language: t.language,
      mcc: t.mcc,
      mnc: t.mnc,
      phoneNumber: match ? match.phoneNumber : "",
      testId: match ? `${match.id}|${match.testIdText || match.id}` : null,
    };
  });
}

/**
 * Единый роутер отправки СМС по 4 провайдерам
 */
async function sendSMS(params: {
  provider: string;
  phone: string;
  text: string;
  senderId: string;
  testId: string | null;
  dmTokenKey?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const cleanPhone = params.phone.replace("+", "");

    switch (params.provider) {
      // 1. MIATEL
      case "miatel": {
        const miatelUrl = process.env.MIATEL_API_URL || "http://155.117.45.233:3000";
        const miatelUser = process.env.MIATEL_USERNAME || "";
        const miatelPass = process.env.MIATEL_PASSWORD || "";

        const url = `${miatelUrl}?username=${encodeURIComponent(
          miatelUser
        )}&password=${encodeURIComponent(miatelPass)}&to=${encodeURIComponent(
          cleanPhone
        )}&text=${encodeURIComponent(params.text)}&from=${encodeURIComponent(
          params.senderId
        )}&test_id=${encodeURIComponent(params.testId || "")}`;

        const res = await fetch(url, { method: "GET" });
        const body = await res.text();
        const isOk = res.ok && !body.toLowerCase().includes("auth failed") && !body.toLowerCase().includes("error");
        return isOk ? { success: true } : { success: false, error: body };
      }

      // 2. FORTYTWO TELECOM
      case "fortytwo": {
        const fortyTwoUrl = process.env.FORTYTWO_API_URL || "https://rest.fortytwo.com/1/im";
        const fortyTwoToken = process.env.FORTYTWO_TOKEN || "";

        const res = await fetch(fortyTwoUrl, {
          method: "POST",
          headers: {
            Authorization: `Token ${fortyTwoToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            destinations: [{ number: cleanPhone }],
            sms_content: { message: params.text, sender_id: params.senderId.substring(0, 11) },
          }),
        });

        const body = await res.text();
        return res.ok ? { success: true } : { success: false, error: body };
      }

      // 3. MESSAGEWHIZ
      case "messagewhiz": {
        const whizUrl = process.env.MESSAGEWHIZ_API_URL || "https://sms.messagewhiz.com/sms";
        const whizKey = process.env.MESSAGEWHIZ_API_KEY || "";

        const res = await fetch(whizUrl, {
          method: "POST",
          headers: {
            apikey: whizKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: cleanPhone,
            from: params.senderId,
            text: params.text,
          }),
        });

        const body = await res.text();
        return res.ok ? { success: true } : { success: false, error: body };
      }

      // 4. DYNAMIC MESSAGING
      case "dm":
      default: {
        const dmUrl = process.env.DM_API_URL || "https://api.sms.dynamicmessaging.co.uk";
        const isOtp = params.dmTokenKey?.toUpperCase().includes("OTP");
        const endpoint = isOtp
          ? `${dmUrl}/api/smsverify/message`
          : `${dmUrl}/api/SMSMessages/v2`;

        const token =
          (params.dmTokenKey && process.env[params.dmTokenKey]) ||
          process.env.DM_API_KEY ||
          "";

        const payload = isOtp
          ? { phoneNumber: params.phone, sender: params.senderId, message: params.text }
          : { message: params.text, sender: params.senderId, contacts: [{ phoneNumber: params.phone }] };

        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const body = await res.text();
        return res.ok ? { success: true } : { success: false, error: body };
      }
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}