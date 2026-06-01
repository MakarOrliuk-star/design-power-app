import { env } from "../env.js";

/**
 * nano-gpt client — ported from the legacy GAS `generatePersonPrompt_`
 * (chat/completions) and `generateItemImage_` (images/generations).
 */

const CHAT_URL = "https://nano-gpt.com/api/v1/chat/completions";
const IMAGES_URL = "https://nano-gpt.com/v1/images/generations";

function headers() {
  return { "Content-Type": "application/json", "x-api-key": env.NANO_GPT_API_KEY ?? "" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the Person image prompt: system = per-brand prompt, user = description.
 * Returns the generated text, or the fallback on any failure (resilient — a
 * missing/failing prompt config must never block generation).
 */
export async function buildPersonPrompt(
  systemPrompt: string,
  userText: string,
): Promise<string> {
  const fallback = userText.trim();
  if (!systemPrompt) return fallback;

  const payload = JSON.stringify({
    model: "google/gemini-3.5-flash",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    temperature: 0.4,
    max_tokens: 800,
    stream: false,
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(CHAT_URL, { method: "POST", headers: headers(), body: payload });
      const text = await res.text();
      if (res.status === 200) {
        const j = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
        const content = j.choices?.[0]?.message?.content;
        return content && content.trim() ? content.trim() : fallback;
      }
      if (!(res.status >= 500 || res.status === 429)) break; // 4xx (non-429): don't retry
    } catch {
      /* retry */
    }
    if (attempt < 3) await sleep(Math.min(6000, 1000 * 2 ** (attempt - 1)));
  }
  return fallback;
}

export interface ItemImageResult {
  success: boolean;
  b64?: string;
  error?: string;
}

/** Generate one Item image (model nano-banana-2). Returns base64. */
export async function generateItemImage(prompt: string): Promise<ItemImageResult> {
  const payload = JSON.stringify({
    prompt,
    model: "nano-banana-2",
    showExplicitContent: false,
    nImages: 1,
    resolution: "1k",
    aspect_ratio: "auto",
  });

  let lastError = "unknown";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(IMAGES_URL, { method: "POST", headers: headers(), body: payload });
      const text = await res.text();
      if (res.status === 200) {
        const j = JSON.parse(text) as { data?: { b64_json?: string; url?: string }[] };
        const d = j.data?.[0];
        if (d?.b64_json) return { success: true, b64: d.b64_json };
        if (d?.url) {
          const img = await fetch(d.url);
          if (img.status === 200) {
            const buf = Buffer.from(await img.arrayBuffer());
            return { success: true, b64: buf.toString("base64") };
          }
          return { success: false, error: `image url fetch failed: ${img.status}` };
        }
        return { success: false, error: `no image in response: ${text.slice(0, 160)}` };
      }
      lastError = `HTTP ${res.status}: ${text.slice(0, 160)}`;
      if (!(res.status >= 500 || res.status === 429)) return { success: false, error: lastError };
    } catch (e) {
      lastError = String(e);
    }
    if (attempt < 3) await sleep(Math.min(8000, 1000 * 2 ** (attempt - 1)));
  }
  return { success: false, error: lastError };
}
