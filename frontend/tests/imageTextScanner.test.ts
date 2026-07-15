import { describe, it, expect, vi } from "vitest";
import {
  useImageTextScanner,
  confidenceLevel,
  type TextWarning,
} from "~/composables/useImageTextScanner";

/**
 * FE Test — текст-скан email-картинок (TASK Трек A, фаза 4.6). Composable
 * держит состояние поп-апа/баннера и «пометить ок» (whitelist по MD5);
 * api мокается — Nuxt-контекст не нужен.
 */

function warning(n: number, drive = false): TextWarning {
  return {
    brand: `Brand${n}`,
    publicId: `smartico/brand${n}/email`,
    url: `https://res.cloudinary.com/x/brand${n}.webp`,
    md5: `${n}`.repeat(32),
    text: "UP TO 500000$ +50 FREE SPINS",
    confidence: 0.9,
    driveFolderId: drive ? `folder-${n}` : null,
  };
}

describe("useImageTextScanner", () => {
  it("setWarnings с непустым списком открывает поп-ап; с пустым — нет", () => {
    const s = useImageTextScanner(vi.fn().mockResolvedValue({ ok: true }));
    s.setWarnings([warning(1), warning(2)]);
    expect(s.popupOpen.value).toBe(true);
    expect(s.activeWarnings.value).toHaveLength(2);
    expect(s.hasWarnings.value).toBe(true);

    s.setWarnings([]);
    expect(s.popupOpen.value).toBe(false);
    expect(s.hasWarnings.value).toBe(false);
  });

  it("markOk шлёт md5 в whitelist и прячет картинку; последняя помеченная закрывает поп-ап", async () => {
    const api = vi.fn().mockResolvedValue({ ok: true });
    const s = useImageTextScanner(api);
    s.setWarnings([warning(1), warning(2)]);

    await s.markOk(warning(1).md5);
    expect(api).toHaveBeenCalledWith("/api/smartico/text-whitelist", {
      method: "POST",
      body: { md5: warning(1).md5 },
    });
    expect(s.activeWarnings.value.map((w) => w.brand)).toEqual(["Brand2"]);
    expect(s.popupOpen.value).toBe(true); // ещё есть предупреждения

    await s.markOk(warning(2).md5);
    expect(s.hasWarnings.value).toBe(false);
    expect(s.popupOpen.value).toBe(false); // помечено всё — закрылся сам
  });

  it("фейл whitelist оставляет предупреждение и ставит ошибку; повтор после фейла работает", async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true });
    const s = useImageTextScanner(api);
    s.setWarnings([warning(1)]);

    await s.markOk(warning(1).md5);
    expect(s.activeWarnings.value).toHaveLength(1);
    expect(s.markError.value).not.toBe("");

    await s.markOk(warning(1).md5); // ретрай
    expect(s.activeWarnings.value).toHaveLength(0);
    expect(s.markError.value).toBe("");
  });

  it("даблклик по «Пометить ок» не шлёт второй запрос (in-flight и уже помеченные)", async () => {
    let release!: () => void;
    const api = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const s = useImageTextScanner(api);
    s.setWarnings([warning(1)]);

    const first = s.markOk(warning(1).md5);
    void s.markOk(warning(1).md5); // пока первый в полёте
    release();
    await first;
    expect(api).toHaveBeenCalledTimes(1);

    await s.markOk(warning(1).md5); // уже approved — тоже no-op
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("closePopup = «игнорировать»: предупреждения остаются для баннера; openPopup открывает снова", () => {
    const s = useImageTextScanner(vi.fn());
    s.setWarnings([warning(1, true)]);
    s.closePopup();
    expect(s.popupOpen.value).toBe(false);
    expect(s.hasWarnings.value).toBe(true);
    s.openPopup();
    expect(s.popupOpen.value).toBe(true);
  });

  it("openPopup без предупреждений — no-op; reset чистит всё", () => {
    const s = useImageTextScanner(vi.fn());
    s.openPopup();
    expect(s.popupOpen.value).toBe(false);

    s.setWarnings([warning(1)]);
    s.reset();
    expect(s.popupOpen.value).toBe(false);
    expect(s.activeWarnings.value).toHaveLength(0);
    expect(s.markError.value).toBe("");
  });

  it("confidenceLevel: грубый бейдж по порогам 0.8 / 0.5", () => {
    expect(confidenceLevel(0.95)).toBe("high");
    expect(confidenceLevel(0.8)).toBe("high");
    expect(confidenceLevel(0.79)).toBe("medium");
    expect(confidenceLevel(0.5)).toBe("medium");
    expect(confidenceLevel(0.49)).toBe("low");
  });
});
