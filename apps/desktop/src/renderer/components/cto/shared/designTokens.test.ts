import { describe, expect, it } from "vitest";
import {
  inputCls,
  selectCls,
  labelCls,
  ACCENT,
  textareaCls,
  cardCls,
  surfaceCardCls,
  recessedPanelCls,
  shellTabBarCls,
  shellBodyCls,
  compactHeaderCls,
  statChipCls,
  stageCardCls,
  pipelineCanvasCls,
  agentStatusMap,
  WORKER_TEMPLATES,
} from "./designTokens";

/* ── ACCENT palette ── */

describe("ACCENT", () => {
  it("exports all five named colors as hex strings", () => {
    expect(ACCENT.purple).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(ACCENT.blue).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(ACCENT.green).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(ACCENT.pink).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(ACCENT.amber).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("has exactly 5 keys", () => {
    expect(Object.keys(ACCENT)).toHaveLength(5);
  });

  it("values are all distinct colors", () => {
    const values = Object.values(ACCENT);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

/* ── CSS class strings ── */

describe("CSS class exports", () => {
  it("inputCls is a non-empty string with common Tailwind input classes", () => {
    expect(inputCls).toBeTruthy();
    expect(typeof inputCls).toBe("string");
    expect(inputCls).toContain("rounded");
    expect(inputCls).toContain("border");
  });

  it("selectCls extends inputCls with appearance-none", () => {
    expect(selectCls).toContain("appearance-none");
    expect(selectCls).toContain("rounded");
  });

  it("labelCls includes uppercase and tracking", () => {
    expect(labelCls).toContain("uppercase");
    expect(labelCls).toContain("tracking");
  });

  it("textareaCls is a valid string with border and resize classes", () => {
    expect(textareaCls).toBeTruthy();
    expect(textareaCls).toContain("border");
    expect(textareaCls).toContain("resize");
  });

  it("cardCls includes rounded corners and shadow", () => {
    expect(cardCls).toContain("rounded-2xl");
    expect(cardCls).toContain("shadow");
  });

  it("surfaceCardCls includes backdrop blur", () => {
    expect(surfaceCardCls).toContain("backdrop-blur");
  });

  it("recessedPanelCls includes inset shadow", () => {
    expect(recessedPanelCls).toContain("shadow");
  });

  it("shellTabBarCls includes flex layout", () => {
    expect(shellTabBarCls).toContain("flex");
  });

  it("shellBodyCls includes background gradient", () => {
    expect(shellBodyCls).toContain("bg-");
  });

  it("compactHeaderCls includes border-b for bottom border", () => {
    expect(compactHeaderCls).toContain("border-b");
  });

  it("statChipCls includes rounded-full for pill shape", () => {
    expect(statChipCls).toContain("rounded-full");
  });

  it("stageCardCls includes hover effects", () => {
    expect(stageCardCls).toContain("hover:");
    expect(stageCardCls).toContain("transition");
  });

  it("pipelineCanvasCls includes gradient background", () => {
    expect(pipelineCanvasCls).toContain("radial-gradient");
  });
});

/* ── agentStatusMap ── */

describe("agentStatusMap", () => {
  it("covers all four agent statuses", () => {
    const statuses = ["running", "active", "paused", "idle"] as const;
    for (const status of statuses) {
      const entry = agentStatusMap[status];
      expect(entry, `missing agentStatusMap entry for: ${status}`).toBeDefined();
      expect(entry.color).toBeTruthy();
      expect(entry.label).toBeTruthy();
      expect(entry.dotCls).toBeTruthy();
      expect(entry.textCls).toBeTruthy();
      expect(entry.bgCls).toBeTruthy();
    }
  });

  it("running status has animate-pulse in dotCls", () => {
    expect(agentStatusMap.running.dotCls).toContain("animate-pulse");
  });

  it("labels match expected display values", () => {
    expect(agentStatusMap.running.label).toBe("Running");
    expect(agentStatusMap.active.label).toBe("Active");
    expect(agentStatusMap.paused.label).toBe("Paused");
    expect(agentStatusMap.idle.label).toBe("Idle");
  });
});

/* ── WORKER_TEMPLATES ── */

describe("WORKER_TEMPLATES", () => {
  it("has 6 templates", () => {
    expect(WORKER_TEMPLATES).toHaveLength(6);
  });

  it("each template has required fields", () => {
    for (const template of WORKER_TEMPLATES) {
      expect(template.id, "template missing id").toBeTruthy();
      expect(template.name, `template ${template.id} missing name`).toBeTruthy();
      expect(template.role, `template ${template.id} missing role`).toBeTruthy();
      expect(template.description, `template ${template.id} missing description`).toBeTruthy();
      expect(template.adapterType, `template ${template.id} missing adapterType`).toBeTruthy();
    }
  });

  it("includes expected template IDs", () => {
    const ids = WORKER_TEMPLATES.map((t) => t.id);
    expect(ids).toContain("backend-engineer");
    expect(ids).toContain("frontend-engineer");
    expect(ids).toContain("qa-tester");
    expect(ids).toContain("devops");
    expect(ids).toContain("researcher");
    expect(ids).toContain("custom");
  });

  it("custom template has empty capabilities", () => {
    const custom = WORKER_TEMPLATES.find((t) => t.id === "custom");
    expect(custom, "custom template should exist").toBeTruthy();
    expect(custom!.capabilities).toHaveLength(0);
    expect(custom!.title).toBe("");
  });

  it("non-custom templates have a model specified", () => {
    const nonCustom = WORKER_TEMPLATES.filter((t) => t.id !== "custom");
    for (const template of nonCustom) {
      expect(template.model, `template ${template.id} missing model`).toBeTruthy();
    }
  });

  it("each template has unique id", () => {
    const ids = WORKER_TEMPLATES.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("backend-engineer has expected capabilities", () => {
    const be = WORKER_TEMPLATES.find((t) => t.id === "backend-engineer");
    expect(be).toBeTruthy();
    expect(be!.capabilities).toContain("api");
    expect(be!.capabilities).toContain("database");
  });

  it("frontend-engineer has expected capabilities", () => {
    const fe = WORKER_TEMPLATES.find((t) => t.id === "frontend-engineer");
    expect(fe).toBeTruthy();
    expect(fe!.capabilities).toContain("react");
    expect(fe!.capabilities).toContain("css");
    expect(fe!.capabilities).toContain("ui");
  });
});
