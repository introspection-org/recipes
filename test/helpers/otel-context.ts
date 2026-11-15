import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  propagation,
  ROOT_CONTEXT,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";

/**
 * The async context an OpenTelemetry SDK registers, so baggage set with
 * `context.with` is still active after an `await`. Returns its teardown.
 */
export function useAsyncContext(): () => void {
  const storage = new AsyncLocalStorage<Context>();
  const manager: ContextManager = {
    active: () => storage.getStore() ?? ROOT_CONTEXT,
    with: (ctx, fn, thisArg, ...args) =>
      storage.run(ctx, () => fn.apply(thisArg, args)),
    bind: (_ctx, target) => target,
    enable() {
      return this;
    },
    disable() {
      storage.disable();
      return this;
    },
  };
  context.setGlobalContextManager(manager);
  return () => context.disable();
}

/** The active baggage's entries, as plain key/value pairs. */
export function activeBaggage(): Record<string, string> {
  return Object.fromEntries(
    (propagation.getBaggage(context.active())?.getAllEntries() ?? []).map(
      ([key, entry]) => [key, entry.value],
    ),
  );
}

/** Run `fn` with `entries` set as baggage. */
export function withBaggage<T>(
  entries: Record<string, string>,
  fn: () => T,
): T {
  let bag = propagation.createBaggage();
  for (const [key, value] of Object.entries(entries)) {
    bag = bag.setEntry(key, { value });
  }
  return context.with(propagation.setBaggage(context.active(), bag), fn);
}
