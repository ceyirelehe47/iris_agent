import {
  InMemoryCredentialStore,
  createModels,
  type Model,
  type Models,
} from "@iris/pi-ai";
import { opencodeGoProvider } from "@iris/pi-ai/providers/opencode-go";

/**
 * R1-P1 live provider seam for the OpenCode Go development profile.
 *
 * The locked pi-ai 0.82.1 ships an `opencodeGoProvider()` factory whose model
 * catalog already contains `deepseek-v4-flash` (baseUrl
 * `https://opencode.ai/zen/go/v1`, openai-completions API). Iris therefore
 * does not hand-write a provider; it composes the built-in factory with the
 * development API key and pins the model id.
 *
 * The built-in provider resolves auth from `OPENCODE_API_KEY` by default, but
 * the Iris development profile declares `api_key_env = OPENCODE_GO_API_KEY`
 * (agent.json). AgentHarness issues provider requests without per-request
 * apiKey options, so the seam pre-registers the key in an
 * `InMemoryCredentialStore` bound to the provider id. This keeps the harness
 * path working without mutating process-wide env.
 */

export const OPENCODE_GO_PROVIDER_ID = "opencode-go";
export const OPENCODE_GO_MODEL_ID = "deepseek-v4-flash";
export const OPENCODE_GO_API_KEY_ENV = "OPENCODE_GO_API_KEY";

export interface OpenCodeGoProviderHandle {
  models: Models;
  model: Model<string>;
}

export function openCodeGoApiKey(): string | undefined {
  return process.env[OPENCODE_GO_API_KEY_ENV];
}

export async function createOpenCodeGoProvider(): Promise<OpenCodeGoProviderHandle> {
  const credentials = new InMemoryCredentialStore();
  const apiKey = openCodeGoApiKey();
  if (apiKey !== undefined) {
    await credentials.modify(OPENCODE_GO_PROVIDER_ID, async () => ({
      type: "api_key",
      key: apiKey,
    }));
  }
  const models = createModels({ credentials });
  models.setProvider(opencodeGoProvider());
  const model = models.getModel(OPENCODE_GO_PROVIDER_ID, OPENCODE_GO_MODEL_ID);
  if (model === undefined) {
    throw new Error(
      `opencode-go model not found: ${OPENCODE_GO_PROVIDER_ID}/${OPENCODE_GO_MODEL_ID}`,
    );
  }
  return { models, model };
}
