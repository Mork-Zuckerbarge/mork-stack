import { getAppControlState } from "./appControl";
import { resolveOllamaHost } from "./ollamaHost";
let hasLoggedOllamaConfig = false;

type OllamaMode = "coding" | "telegram" | "x" | "default";

async function pickModel(mode: OllamaMode) {
  const controlState = await getAppControlState();
  const selectedModel = controlState.controls.selectedOllamaModel.trim();

  if (mode === "coding") {
    return process.env.OLLAMA_MODEL_CODING || selectedModel || process.env.OLLAMA_MODEL || "llama3.1:8b";
  }
  if (mode === "telegram") {
    return process.env.OLLAMA_MODEL_TELEGRAM || selectedModel || process.env.OLLAMA_MODEL || "llama3.1:8b";
  }
  if (mode === "x") {
    return process.env.OLLAMA_MODEL_X || selectedModel || process.env.OLLAMA_MODEL || "llama3.1:8b";
  }
  return selectedModel || process.env.OLLAMA_MODEL || "llama3.1:8b";
}

export async function ollama(prompt: string, mode: OllamaMode = "default") {
  const hostResolution = await resolveOllamaHost(process.env.OLLAMA_HOST);
  const host = hostResolution.host;
  const model = await pickModel(mode);
  const ctx = Number(process.env.OLLAMA_CTX || 8192);

  if (!hasLoggedOllamaConfig) {
    console.log(`[mork] ollama host: ${host}`);
    if (hostResolution.usedFallback) {
      console.log(`[mork] requested OLLAMA_HOST: ${hostResolution.requestedHost}`);
    }
    console.log(`[mork] default model: ${process.env.OLLAMA_MODEL || "llama3.1:8b"}`);
    console.log(`[mork] coding model: ${process.env.OLLAMA_MODEL_CODING || "(inherits default)"}`);
    console.log(`[mork] telegram model: ${process.env.OLLAMA_MODEL_TELEGRAM || "(inherits default)"}`);
    console.log(`[mork] x model: ${process.env.OLLAMA_MODEL_X || "(inherits default)"}`);
    console.log(`[mork] ollama ctx: ${ctx}`);
    hasLoggedOllamaConfig = true;
  }

  const r = await fetch(`${host}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        num_ctx: ctx,
      },
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Ollama error ${r.status}: ${text}`);
  }

  const data = await r.json();
  return String(data.response || "").trim();
}
