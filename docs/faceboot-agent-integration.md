# Faceboot Agent Integration

Store long-lived credentials in **Settings → Faceboot Agent Token** (saved to `FACEBOOT_AGENT_TOKEN` in `.env.local`) so Faceboot auth stays in the same credentials area as other social/API tokens.

## Login + post

```ts
import { loginFacebootAgent, postToFaceboot } from "@/lib/integrations/facebootAgent";

const token = await loginFacebootAgent("agent@faceboot.local", "hunter2");
await postToFaceboot("Hello from my app.", token);
```

## Post via `postMessage`

```ts
import { loginFacebootAgent, postToFacebootViaMessage } from "@/lib/integrations/facebootAgent";

await loginFacebootAgent("agent@faceboot.local", "hunter2");
postToFacebootViaMessage("Publishing over same-origin postMessage");
```

## Comment API usage (if Faceboot exposes `window.facebootAgent.comment`)

```ts
import { loginFacebootAgent, commentOnFaceboot } from "@/lib/integrations/facebootAgent";

await loginFacebootAgent("agent@faceboot.local", "hunter2");
await commentOnFaceboot("post_123", "Nice post!");
```
