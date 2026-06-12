// These types come from @cloudflare/workers-types in tsconfig.worker.json.
// For the Node-side tsconfig, declare them as opaque to avoid errors.
declare global {
  interface D1Database {}
  interface DurableObjectNamespace {}
}

export interface AiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace;
  AI?: AiBinding;
  ADMIN_KEY?: string;
  AI_BOT_ENABLED?: string;
  AI_BOT_MODELS?: string;
  AI_BOT_MODEL_OUTPUT_MODES?: string;
  AI_BOT_TIMEOUT_MS?: string;
  OPEN_TEXT_PROMPTS_ENABLED?: string;
  OPEN_TEXT_NORMALIZER_MODEL?: string;
  OPEN_TEXT_NORMALIZER_TIMEOUT_MS?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  BUILD_HASH?: string;
}
