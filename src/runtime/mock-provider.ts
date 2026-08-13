import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
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
}

export function createMockProvider(options: MockProviderOptions = {}): MockProviderHandle {
  const faux = fauxProvider({ provider: "mock-iris", models: [{ id: "mock-deepseek-v4-flash" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  if (options.failWith !== undefined) {
    // First provider call throws — the REAL harness failure path runs
    // (emitRunFailure → failure message → agent_end → native settled).
    faux.setResponses([
      () => {
        throw options.failWith as Error;
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
    faux.setResponses([toolFactory, finalFactory]);
  }
  const model = faux.getModel("mock-deepseek-v4-flash") ?? faux.getModel();
  return { models, model, faux };
}
