import { describe, it, expect, vi, beforeEach } from "vitest";

// requestStyleProfile ходит в nano-gpt — в тестах сеть подменяется целиком.
vi.mock("../src/lib/nanogpt.js", () => ({
  chatCompletion: vi.fn(),
}));

import { chatCompletion } from "../src/lib/nanogpt.js";
import { clampStyleProfile, requestStyleProfile } from "../src/lib/styleProfile.js";

const mockedChat = vi.mocked(chatCompletion);

const LIB = [
  "https://cdn.example/decor/coin.png",
  "https://cdn.example/decor/bill.png",
  "https://cdn.example/decor/percent.png",
];

describe("clampStyleProfile — ограничение 3 DV-E1: выход зажимается, мусор отбрасывается", () => {
  it("мусор и пустота → null (детерминированный фолбэк движка)", () => {
    expect(clampStyleProfile(null, { libraryUrls: LIB })).toBeNull();
    expect(clampStyleProfile("not an object", { libraryUrls: LIB })).toBeNull();
    expect(clampStyleProfile({}, { libraryUrls: LIB })).toBeNull();
    expect(clampStyleProfile({ glowHex: "purple" }, { libraryUrls: LIB })).toBeNull();
  });

  it("glowHex нормализуется в верхний регистр", () => {
    const p = clampStyleProfile({ glowHex: "#7a1b8f" }, { libraryUrls: LIB });
    expect(p?.glowHex).toBe("#7A1B8F");
  });

  it("неизвестный материал отбрасывается, известный проходит", () => {
    expect(
      clampStyleProfile({ typoMaterial: "chrome-mirror" }, { libraryUrls: LIB }),
    ).toBeNull();
    expect(
      clampStyleProfile({ typoMaterial: "neon" }, { libraryUrls: LIB })?.typoMaterial,
    ).toBe("neon");
  });

  it("токены: КАПС, обрезка по словам до 14 символов, дедуп, максимум 3", () => {
    const p = clampStyleProfile(
      {
        tokens: [
          "mega new year jackpot bonanza", // длинная фраза → обрезка по целым словам
          "big win",
          "BIG WIN", // дубль после капса
          "x", // обрывок — вон
          "CASHBACK",
          "FREE SPINS", // уже 4-й уникальный — за пределами лимита
        ],
      },
      { libraryUrls: LIB },
    );
    expect(p?.tokens).toEqual(["MEGA NEW YEAR", "BIG WIN", "CASHBACK"]);
    for (const t of p?.tokens ?? []) expect(t.length).toBeLessThanOrEqual(14);
  });

  it("density клампится в 0..1", () => {
    expect(clampStyleProfile({ density: 1.7 }, { libraryUrls: LIB })?.density).toBe(1);
    expect(clampStyleProfile({ density: -0.2 }, { libraryUrls: LIB })?.density).toBe(0);
    expect(clampStyleProfile({ density: 0.4 }, { libraryUrls: LIB })?.density).toBe(0.4);
    expect(clampStyleProfile({ density: Number.NaN }, { libraryUrls: LIB })).toBeNull();
  });

  it("decorUrls: только пересечение с библиотекой; пусто → поле выпадает (= вся библиотека)", () => {
    const p = clampStyleProfile(
      { decorUrls: [LIB[0]!, "https://evil.example/x.png"] },
      { libraryUrls: LIB },
    );
    expect(p?.decorUrls).toEqual([LIB[0]]);

    const none = clampStyleProfile(
      { glowHex: "#112233", decorUrls: ["https://evil.example/x.png"] },
      { libraryUrls: LIB },
    );
    expect(none?.decorUrls).toBeUndefined();
    expect(none?.glowHex).toBe("#112233"); // остальные поля не страдают
  });
});

describe("requestStyleProfile — вызов модели с фолбэком в null", () => {
  beforeEach(() => {
    mockedChat.mockReset();
  });

  const REQ = {
    campaignPrompt: "NEW YEAR MEGA WIN, дарим фриспины",
    brandName: "Betnella(Men)",
    libraryUrls: LIB,
    layerColorHex: "#AA3355",
  };

  it("валидный ответ (даже в ```-ограде) → клампованный профиль с source=model", async () => {
    mockedChat.mockResolvedValue(
      '```json\n{"glowHex": "#ff2266", "typoMaterial": "neon", "tokens": ["mega win"], "density": 0.8, "decorIndices": [0, 2, 99]}\n```',
    );
    const p = await requestStyleProfile(REQ);
    expect(p).toEqual({
      glowHex: "#FF2266",
      typoMaterial: "neon",
      tokens: ["MEGA WIN"],
      density: 0.8,
      decorUrls: [LIB[0], LIB[2]], // индекс 99 за пределами библиотеки — выпал
      source: "model",
    });
  });

  it("модель недоступна / не-JSON / пустой JSON → null, рендер не блокируется", async () => {
    mockedChat.mockResolvedValue(null);
    expect(await requestStyleProfile(REQ)).toBeNull();

    mockedChat.mockResolvedValue("Sure! Here is my styling advice: use gold.");
    expect(await requestStyleProfile(REQ)).toBeNull();

    mockedChat.mockResolvedValue("{}");
    expect(await requestStyleProfile(REQ)).toBeNull();
  });

  it("координаты в ответе модели не имеют канала доставки: неизвестные поля отрезаются схемой", async () => {
    // Модель попыталась «подвинуть» персонажа — таких полей в профиле нет,
    // strip-схема их выбрасывает, до движка доходит только стиль (D-E4).
    mockedChat.mockResolvedValue(
      '{"personX": 0.1, "zones": [{"x": 0}], "glowHex": "#001122"}',
    );
    const p = await requestStyleProfile(REQ);
    expect(p).toEqual({ glowHex: "#001122", source: "model" });
  });
});
