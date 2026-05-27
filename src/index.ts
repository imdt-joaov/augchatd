import { BootConfigError, loadBootConfig } from "./env.ts";
import { createApp } from "./server.ts";
import { initMcpConnectors } from "./mcp.ts";
import { initRagConnectors } from "./rag.ts";
import { initTrace } from "./trace.ts";
import { initStorageForDemo } from "./storage.ts";
import { listProviderModels } from "./provider-models.ts";
import { coldStorageConfigFrom, probeWritability } from "./cold-storage.ts";

// Wrap the boot-config load so a BootConfigError prints just `err.message`
// (no Bun stack) and exits 1 — the missing-file `cp` hint and the
// field-validation pointers were carefully formatted to stand alone.
let config;
try {
  config = loadBootConfig();
} catch (err) {
  if (err instanceof BootConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

initTrace(config.trace_dir);

if (config.mode === "demo" && config.demo) {
  // Probe the LLM credential up front by calling the provider's list-models
  // endpoint with the supplied key. A bad key surfaces here as a clean
  // boot failure ("LLM credential probe failed …") instead of an opaque
  // 401 on the user's first chat turn. Mirrors the S3 writability check
  // below (per contract-session-create §"Tests S3 writability").
  try {
    await listProviderModels(config.demo.model.provider, config.demo.model.api_key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `\nLLM credential probe failed for ${config.demo.model.provider}: ${msg}\n\n` +
        `Check local/demo_session.json → model.api_key (and model.provider).\n`,
    );
    process.exit(1);
  }
  // S3 writability probe — same posture as the LLM probe and the same
  // promise the production POST /sessions makes. Skipped when storage
  // is absent (hot-only mode).
  let cold;
  try {
    cold = coldStorageConfigFrom(config.demo.storage);
  } catch (err) {
    console.error(
      `\nDemo session storage is malformed: ${err instanceof Error ? err.message : String(err)}\n\n` +
        `Either fix the storage.s3 block in local/demo_session.json or remove it entirely for hot-only mode.\n`,
    );
    process.exit(1);
  }
  if (cold) {
    try {
      await probeWritability(cold);
    } catch (err) {
      console.error(
        `\nS3 writability probe failed for bucket "${cold.bucket}" at ${cold.endpoint}: ${
          err instanceof Error ? err.message : String(err)
        }\n\n` +
          `Check local/demo_session.json → storage.s3 (or delete the storage block for hot-only mode).\n`,
      );
      process.exit(1);
    }
  }
  // Open hot SQLite for the demo (tenant, user) before the first
  // conversation/chat request — avoids first-request latency spike.
  initStorageForDemo(config.demo.user_id);
  // MCP and RAG clients are expensive (handshake, persistent connection)
  // — initialize them once at boot. Each POST /demo/sessions mints a
  // SessionRecord with its own connector array, but the clients are
  // shared via the module-level registry in mcp.ts / rag.ts (keyed by
  // descriptive_id).
  const mcpConnectors = config.demo.connectors.filter((c) => c.type === "mcp");
  const ragConnectors = config.demo.connectors.filter((c) => c.type === "rag");
  if (mcpConnectors.length > 0) await initMcpConnectors(mcpConnectors);
  if (ragConnectors.length > 0) await initRagConnectors(ragConnectors);
}

const app = createApp(config);

// Boot banner — `mode` is also exposed via GET /healthz, which is the
// canonical signal an operator should gate production deploys on (per
// story 0009).
console.log(`augchatd up on :${config.port} (mode=${config.mode})`);
if (config.mode === "demo" && config.demo) {
  console.log(`  demo: open http://localhost:${config.port}/demo/`);
  console.log(`  demo: ttl_seconds=${config.demo_ttl_seconds}`);
  console.log(`  demo: model=${config.demo.model.provider}/${config.demo.model.model_id}`);
  console.log(
    `  demo: cold storage=${config.demo.storage ? "configured" : "hot-only"}`,
  );
  console.log(`  demo: theme=${config.demo.theme}`);
}
if (config.trace_dir) {
  console.log(`  trace: appending per-conversation JSONL to ${config.trace_dir}`);
}

export default {
  port: config.port,
  fetch: app.fetch,
  // Bun.serve defaults to a 10-second idleTimeout — the connection drops
  // if the server doesn't write for 10s. Reasoning models (gpt-5-mini,
  // o1, …) commonly go silent for 12–30s between tool calls while the
  // model "thinks" without emitting tokens; the SSE response is open but
  // no bytes flow during the reasoning gap. With the default, Bun closes
  // the socket mid-stream, the server keeps writing into a dead
  // connection (trace shows response.finish; the browser sees
  // ERR_INCOMPLETE_CHUNKED_ENCODING). 255 is Bun's documented max — well
  // above any normal silent gap, and a 4-minute slow-client window is
  // acceptable for this workload (chat with tool-use loops).
  idleTimeout: 255,
};
