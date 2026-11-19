import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";

const { api, toast } = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn() }));
vi.mock("../src/web/connection.js", () => ({ api }));
vi.mock("../src/web/transcript.js", () => ({ planCardHtml: vi.fn(), unesc: vi.fn() }));
vi.mock("../src/web/notifications.js", () => ({ toast, askText: vi.fn() }));
import { mountBrainR4 } from "../src/web/project/brain-r4.js";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("keeps a toggled setting when the initial GET resolves after PATCH, and uses the server's PATCH value", async () => {
  const dom = new JSDOM('<main><div class="brain"><div id="brain-filters"></div></div></main>');
  vi.stubGlobal("document", dom.window.document);
  let resolveGet!: (value: unknown) => void;
  const get = new Promise(resolve => { resolveGet = resolve; });
  let resolvePatch!: (value: unknown) => void;
  const patch = new Promise(resolve => { resolvePatch = resolve; });
  api.mockImplementation((url: string, options?: { method?: string }) => {
    if (url.endsWith('/settings')) return options?.method === 'PATCH' ? patch : get;
    return Promise.resolve({ proposals: [], changes: [], packs: [], sources: [] });
  });
  try {
    mountBrainR4(dom.window.document.querySelector('main'), { pid: 'project' }, vi.fn());
    const checkbox = dom.window.document.querySelector<HTMLInputElement>('[data-review]')!;
    checkbox.click();
    expect(api).toHaveBeenCalledWith('/api/projects/project/brain/settings', { method: 'PATCH', body: JSON.stringify({ reviewBeforeSaving: true }) });
    resolvePatch({ reviewBeforeSaving: true });
    await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
    resolveGet({ reviewBeforeSaving: false });
    await get; await Promise.resolve();
    expect(checkbox.checked).toBe(true);
    // The next PATCH returns true even though the UI requested false.
    checkbox.click(); await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(checkbox.checked).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});
