import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Model,
  type Models,
  type FauxResponseStep,
} from "@iris/pi-ai";

export interface MockProviderHandle {
  models: Models;
  model: Model<string>;
  faux: ReturnType<typeof fauxProvider>;
}

export interface MockProviderOptions {
  onContext?: (messages: unknown[]) => void;
  /** When set, the faux provider throws this error on its first call. */
  failWith?: Error;
  /**
   * Override the default looping response pair with an exact response
   * sequence (used by C7 native-settled fault tests to control provider
   * liveness: hang / reject / settle).
   */
  responses?: FauxResponseStep[];
  /**
   * Extra model ids to register on the faux provider (fallback-chain tests
   * need a second model slot). The primary model is always
   * "mock-deepseek-v4-flash".
   */
  extraModelIds?: string[];
}

export function createMockProvider(options: MockProviderOptions = {}): MockProviderHandle {
  const modelDefs = [
    { id: "mock-deepseek-v4-flash" },
    ...(options.extraModelIds ?? []).map((id) => ({ id })),
  ];
  const faux = fauxProvider({ provider: "mock-iris", models: modelDefs });
  const models = createModels();
  models.setProvider(faux.provider);
  if (options.failWith !== undefined) {
    // First provider call throws — the REAL harness failure path runs
    // (emitRunFailure → failure message → agent_end → native settled).
    const failWith = options.failWith;
    faux.setResponses([
      () => {
        throw failWith;
      },
    ]);
  } else {
    // Responses LOOP: each tool-turn factory re-appends the pair after
    // consumption, so any number of prompts (multi-prompt coordinator tests)
    // always have a response queued.
    const toolTurn = fauxAssistantMessage(
      [fauxToolCall("test_read_tool", { query: "iris" }, { id: "tool-call-1" })],
      { stopReason: "toolUse" },
    );
    const finalTurn = fauxAssistantMessage("mock assistant final");
    const toolFactory: FauxResponseStep = (context) => {
      options.onContext?.(context.messages);
      faux.appendResponses([toolFactory, finalFactory]);
      return toolTurn;
    };
    const finalFactory: FauxResponseStep = (context) => {
      options.onContext?.(context.messages);
      return finalTurn;
    };
    faux.setResponses(options.responses ?? [toolFactory, finalFactory]);
  }
  const model = faux.getModel("mock-deepseek-v4-flash") ?? faux.getModel();
  return { models, model, faux };
}
