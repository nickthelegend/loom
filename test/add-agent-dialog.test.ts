// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitUntil } from "./helpers.js";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/web/connection.js", () => ({ api }));

let addAgents: (pid: string, kind: string) => Promise<unknown>;
beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage ??= {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  };
  window.matchMedia ??= (() => ({ matches: false })) as typeof window.matchMedia;
  // @ts-expect-error — plain browser JS
  ({ addAgents } = await import("../src/web/project/add-agent.js"));
});
beforeEach(() => { api.mockReset(); });
afterEach(() => { document.body.innerHTML = ""; });

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const submit = () => document.querySelector<HTMLFormElement>("form")!.requestSubmit();
const cancel = () => document.querySelector<HTMLButtonElement>("[data-cancel]")!.click();

describe("add-agent dialog", () => {
  it("offers escaped suggestions but submits a freely typed model and count", async () => {
    api.mockResolvedValueOnce({ models: ['suggested', 'model"<probe>'] });
    const result = { agents: [{ id: "echo" }, { id: "echo-2" }, { id: "echo-3" }] };
    api.mockResolvedValueOnce(result);
    const pending = addAgents("project-a", "echo");
    await waitUntil(() => document.querySelectorAll("#addmodels option").length === 2);
    expect([...document.querySelectorAll<HTMLOptionElement>("option")].map((o) => o.value)).toEqual(['suggested', 'model"<probe>']);
    expect(document.querySelector("probe")).toBeNull();
    expect(api).toHaveBeenCalledWith("/api/projects/project-a/agents/models?kind=echo");
    input("addmodel").value = "custom-model";
    input("addcount").value = "3";
    submit();
    expect(await pending).toEqual(result);
    expect(api).toHaveBeenLastCalledWith("/api/projects/project-a/agents", {
      method: "POST", body: JSON.stringify({ kind: "echo", count: 3, model: "custom-model" }),
    });
    expect(document.querySelector("form")).toBeNull();
  });

  it("still adds with the default model when suggestions fail", async () => {
    api.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ id: "echo" });
    const pending = addAgents("project-a", "echo");
    expect(input("addcount").value).toBe("1");
    submit();
    await pending;
    expect(api).toHaveBeenLastCalledWith("/api/projects/project-a/agents", {
      method: "POST", body: JSON.stringify({ kind: "echo", count: 1 }),
    });
  });

  it("rejects invalid counts without posting and cancels cleanly", async () => {
    api.mockResolvedValue({ models: [] });
    const pending = addAgents("project-a", "echo");
    for (const value of ["0", "9", "1.5", ""]) {
      input("addcount").value = value;
      submit();
      expect(input("addcount").checkValidity()).toBe(false);
    }
    expect(api).toHaveBeenCalledTimes(1);
    cancel();
    expect(await pending).toBeNull();
  });

  it("requires a model for API workers and supports Escape", async () => {
    api.mockResolvedValue({ models: [] });
    const pending = addAgents("project-a", "model");
    submit();
    expect(input("addmodel").checkValidity()).toBe(false);
    input("addmodel").value = "   ";
    submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Choose a model");
    expect(api).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await pending).toBeNull();
  });

  it("shows API errors in the form and retries without losing the selection", async () => {
    api.mockResolvedValueOnce({ models: [] }).mockRejectedValueOnce(new Error("could not add"));
    const pending = addAgents("project-a", "echo");
    input("addmodel").value = "custom";
    input("addcount").value = "2";
    submit();
    submit();
    await waitUntil(() => document.querySelector('[role="alert"]')?.textContent === "could not add");
    expect(api).toHaveBeenCalledTimes(2);
    expect(input("addmodel").value).toBe("custom");
    expect(input("addcount").value).toBe("2");
    api.mockResolvedValueOnce({ agents: [{ id: "echo" }, { id: "echo-2" }] });
    submit();
    await pending;
    expect(api).toHaveBeenCalledTimes(3);
  });
});
