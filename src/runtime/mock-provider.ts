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
}

export function createMockProvider(options: MockProviderOptions = {}): MockProviderHandle {
  const faux = fauxProvider({ provider: "mock-iris", models: [{ id: "mock-deepseek-v4-flash" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const capture =
    (message: AssistantMessage): FauxResponseStep =>
    (context) => {
      options.onContext?.(context.messages);
      return message;
    };
  faux.setResponses([
    capture(
      fauxAssistantMessage(
        [fauxToolCall("test_read_tool", { query: "iris" }, { id: "tool-call-1" })],
        { stopReason: "toolUse" },
      ),
    ),
    capture(fauxAssistantMessage("mock assistant final")),
  ]);
  const model = faux.getModel("mock-deepseek-v4-flash") ?? faux.getModel();
  return { models, model, faux };
}
