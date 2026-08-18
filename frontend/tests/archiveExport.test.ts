import { describe, it, expect } from "vitest";
import { buildExportQuery, ARCHIVE_TABS } from "../app/composables/useArchive";
import { TABS, RESULT_TABS } from "../app/composables/useResult";

// Задача 4 + TASK welcome-packs — the Archive gets its own pack tabs. They must
// live in ARCHIVE_TABS only: RESULT_TABS already appends its own pack tabs, so a
// pack entry leaking into the shared TABS would double it on Result.
describe("ARCHIVE_TABS", () => {
  it("appends the pack tabs to the shared ones", () => {
    expect(ARCHIVE_TABS.map((t) => t.key)).toEqual([
      ...TABS.map((t) => t.key),
      "tournament",
      "welcome",
    ]);
  });

  it("keeps the shared TABS pack-free (Result stays single-tabbed per pack)", () => {
    expect(TABS.some((t) => t.key === "tournament" || t.key === "welcome")).toBe(false);
    expect(RESULT_TABS.filter((t) => t.key === "tournament")).toHaveLength(1);
    expect(RESULT_TABS.filter((t) => t.key === "welcome")).toHaveLength(1);
  });
});

// TASK §2 — ZIP export query: an explicit selection wins over the filters (the
// backend ignores filters when `ids` is present), otherwise the current filters.
describe("buildExportQuery", () => {
  it("ids present → sends only ids, no filters", () => {
    const qs = buildExportQuery({
      tab: "person",
      period: "week",
      search: "slot",
      ids: ["g1", "g2"],
    });
    const p = new URLSearchParams(qs);
    expect(p.get("ids")).toBe("g1,g2");
    expect(p.get("tab")).toBeNull();
    expect(p.get("period")).toBeNull();
    expect(p.get("search")).toBeNull();
  });

  it("no ids → sends tab + period (+ trimmed search)", () => {
    const p = new URLSearchParams(
      buildExportQuery({ tab: "item", period: "3months", search: "  Nike  " }),
    );
    expect(p.get("ids")).toBeNull();
    expect(p.get("tab")).toBe("item");
    expect(p.get("period")).toBe("3months");
    expect(p.get("search")).toBe("Nike");
  });

  it("omits empty/whitespace search", () => {
    const p = new URLSearchParams(
      buildExportQuery({ tab: "generated", period: "today", search: "   " }),
    );
    expect(p.get("search")).toBeNull();
  });

  it("empty ids array is treated as no selection", () => {
    const p = new URLSearchParams(
      buildExportQuery({ tab: "generated", period: "month", ids: [] }),
    );
    expect(p.get("tab")).toBe("generated");
    expect(p.get("ids")).toBeNull();
  });
});
