import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock env to avoid its import-time validation (and to control the API key).
const cfg = vi.hoisted(() => ({ key: "test-key" as string | undefined }));
vi.mock("../src/env.js", () => ({
  get env() {
    return { NANO_GPT_API_KEY: cfg.key };
  },
}));

import { isAsciiPrompt, sanitizeAscii, ensureEnglishPrompt } from "../src/lib/promptLang.js";

/** Minimal nano-gpt chat/completions 200 response with the given content. */
function chatResponse(content: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200 },
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  cfg.key = "test-key";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isAsciiPrompt", () => {
  it("accepts plain English (incl. punctuation and digits)", () => {
    expect(isAsciiPrompt("a red car, 2 wheels!")).toBe(true);
    expect(isAsciiPrompt("")).toBe(true);
  });

  it("rejects Cyrillic and typographic unicode", () => {
    expect(isAsciiPrompt("красная машина")).toBe(false);
    expect(isAsciiPrompt("nice — view")).toBe(false); // em dash
  });
});

describe("sanitizeAscii", () => {
  it("maps typography to ASCII equivalents", () => {
    expect(sanitizeAscii("“cat” — it’s here…")).toBe(
      '"cat" - it\'s here...',
    );
  });

  it("drops remaining non-ASCII and collapses whitespace", () => {
    expect(sanitizeAscii("a  кот  b")).toBe("a b");
  });
});

describe("ensureEnglishPrompt", () => {
  it("passes an ASCII prompt through without calling the translator", async () => {
    const res = await ensureEnglishPrompt("  a red car  ");
    expect(res).toEqual({ ok: true, prompt: "a red car" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("translates a Russian prompt to English", async () => {
    fetchMock.mockResolvedValue(chatResponse("a red car"));
    const res = await ensureEnglishPrompt("красная машина");
    expect(res).toEqual({ ok: true, prompt: "a red car" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The user's text rides in the user message, untouched.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages[1]).toEqual({ role: "user", content: "красная машина" });
  });

  it("sanitizes translator typography down to ASCII", async () => {
    fetchMock.mockResolvedValue(chatResponse("a “cozy” room — warm light"));
    const res = await ensureEnglishPrompt("уютная комната");
    expect(res).toEqual({ ok: true, prompt: 'a "cozy" room - warm light' });
  });

  it("fails when the translator returns a non-retryable error", async () => {
    fetchMock.mockResolvedValue(new Response("bad request", { status: 400 }));
    const res = await ensureEnglishPrompt("красная машина");
    expect(res).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 4xx: no retries
  });

  it("fails when the translation sanitizes down to nothing", async () => {
    fetchMock.mockResolvedValue(chatResponse("котик")); // translator echoed non-ASCII
    const res = await ensureEnglishPrompt("котик");
    expect(res).toEqual({ ok: false });
  });

  it("fails without an API key and never calls fetch", async () => {
    cfg.key = undefined;
    const res = await ensureEnglishPrompt("красная машина");
    expect(res).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
