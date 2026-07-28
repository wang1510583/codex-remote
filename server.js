import { createServer } from "node:http";
import { port, host } from "./src/config.js";
import { handle } from "./src/router.js";
import { attachConnectorWebSocket } from "./src/connectors.js";
import { attachNativeNotificationWebSocket } from "./src/native-notifications.js";
import { setupWebPush } from "./src/webpush.js";
import { markInterruptedInflight } from "./src/runner.js";

process.on("uncaughtException", (error) => {
  console.error("uncaughtException", error);
});

process.on("unhandledRejection", (error) => {
  console.error("unhandledRejection", error);
});

const server = createServer(handle);

attachConnectorWebSocket(server);
attachNativeNotificationWebSocket(server);

await setupWebPush().catch((error) => console.error("failed to setup web push", error));
await markInterruptedInflight("").catch((error) => console.error("failed to mark interrupted task", error));

server.listen(port, host, () => {
  console.log(`Codex Remote Web listening on http://${host}:${port}`);
});
