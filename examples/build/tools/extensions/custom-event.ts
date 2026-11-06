// #region docs:build/tools/custom-event
import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";

const logs = new IntrospectionLogs({
  token: process.env.INTROSPECTION_TOKEN,
  baseOtelUrl: process.env.INTROSPECTION_BASE_OTEL_URL,
});
logs.track("refund_drafted", { orderId: "1842" });
await logs.flush();
// #endregion docs:build/tools/custom-event
