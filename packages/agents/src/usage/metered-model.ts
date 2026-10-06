import type { Model, ModelProvider, ModelRequest, ModelResponse } from '@openai/agents';
import { recordUsage } from './ledger';

/** Wraps a model so each response's usage is attributed to an agent and model name. */
export class MeteredModel implements Model {
  private inner: Promise<Model>;

  constructor(
    inner: Model | Promise<Model>,
    readonly agent: string,
    readonly modelName: string,
  ) {
    this.inner = Promise.resolve(inner);
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const response = await (await this.inner).getResponse(request);
    recordUsage(this.agent, this.modelName, response.usage);
    return response;
  }

  async *getStreamedResponse(request: ModelRequest) {
    // Streaming is not used for agent runs here; usage is recorded on non-streamed responses.
    yield* (await this.inner).getStreamedResponse(request);
  }
}

/** Builds metered models for agents from a provider (OpenAIProvider in production). */
export function meteredModelFactory(provider: ModelProvider) {
  return (agent: string, modelName: string): Model => new MeteredModel(provider.getModel(modelName), agent, modelName);
}
