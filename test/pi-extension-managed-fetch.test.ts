import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecipesExtension } from "../src/pi-extension.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const MANAGED_FETCH_INSTALLER_SYMBOL = Symbol.for(
  "introspection.installManagedFetch"
);
const MANAGED_EGRESS_URL_ENV = "INTROSPECTION_EGRESS_URL";

function context() {
  return {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    ui: { notify: vi.fn() },
  } as any;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, MANAGED_FETCH_INSTALLER_SYMBOL);
});

describe("Recipes managed fetch integration", () => {
  it("spells the installer key the Runtime's proxy-preload publishes", () => {
    expect(Symbol.keyFor(MANAGED_FETCH_INSTALLER_SYMBOL)).toBe(
      "introspection.installManagedFetch"
    );
  });

  it("ensures the managed fetch after Pi session startup", async () => {
    const install = vi.fn();
    Reflect.set(globalThis, MANAGED_FETCH_INSTALLER_SYMBOL, install);
    const pi = createMockExtensionAPI();
    createRecipesExtension({ env: {} })(pi);

    await pi.emitExtensionEvent(
      { type: "session_start", reason: "startup" } as any,
      context()
    );

    expect(install).toHaveBeenCalledOnce();
  });

  it("rechecks the managed fetch immediately before provider requests", async () => {
    const install = vi.fn();
    Reflect.set(globalThis, MANAGED_FETCH_INSTALLER_SYMBOL, install);
    const pi = createMockExtensionAPI();
    createRecipesExtension({ env: {} })(pi);

    await pi.emitExtensionEvent(
      { type: "before_provider_request", payload: {} } as any,
      context()
    );

    expect(install).toHaveBeenCalledOnce();
  });

  it("is a no-op outside an Introspection-managed Runtime", async () => {
    const pi = createMockExtensionAPI();
    createRecipesExtension({ env: {} })(pi);
    const ctx = context();

    await expect(
      pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      )
    ).resolves.toBeDefined();

    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("managed fetch"),
      expect.anything()
    );
  });

  it("ignores a malformed installer instead of aborting the session", async () => {
    Reflect.set(globalThis, MANAGED_FETCH_INSTALLER_SYMBOL, "not-a-function");
    const pi = createMockExtensionAPI();
    createRecipesExtension({ env: {} })(pi);

    await expect(
      pi.emitExtensionEvent(
        { type: "before_provider_request", payload: {} } as any,
        context()
      )
    ).resolves.toBeDefined();
  });

  it("warns, without failing, when managed egress is configured but the preload is missing", async () => {
    const pi = createMockExtensionAPI();
    createRecipesExtension({
      env: { [MANAGED_EGRESS_URL_ENV]: "http://egress.internal:8081" },
    })(pi);
    const ctx = context();

    await pi.emitExtensionEvent(
      { type: "session_start", reason: "startup" } as any,
      ctx
    );

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        `${MANAGED_EGRESS_URL_ENV} is set but the Runtime's managed fetch is not installed`
      ),
      "warning"
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("cannot start"),
      expect.anything()
    );
  });

  it("reads the configured env, not the ambient process", async () => {
    const previous = process.env[MANAGED_EGRESS_URL_ENV];
    process.env[MANAGED_EGRESS_URL_ENV] = "http://egress.internal:8081";
    try {
      const pi = createMockExtensionAPI();
      createRecipesExtension({ env: {} })(pi);
      const ctx = context();

      await pi.emitExtensionEvent(
        { type: "session_start", reason: "startup" } as any,
        ctx
      );

      expect(ctx.ui.notify).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env[MANAGED_EGRESS_URL_ENV];
      else process.env[MANAGED_EGRESS_URL_ENV] = previous;
    }
  });
});
