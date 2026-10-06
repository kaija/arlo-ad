// Deterministic Model for tests ("假 model"): a script decides each response from the request.
import { Usage, type AgentInputItem, type AgentOutputItem, type Model, type ModelRequest, type ModelResponse } from '@openai/agents';

export type Script = (request: ModelRequest, ctx: { call: number; toolNames: string[]; lastItem: AgentInputItem | undefined }) => AgentOutputItem[];

let callSeq = 0;

export function say(text: string): AgentOutputItem {
  return { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] };
}

export function callTool(name: string, args: Record<string, unknown>): AgentOutputItem {
  return { type: 'function_call', callId: `call_${++callSeq}`, name, arguments: JSON.stringify(args), status: 'completed' };
}

/** Text of a tool result item, for scripts that react to tool output. */
export function toolResultText(item: AgentInputItem | undefined): string | undefined {
  const i = item as { type?: string; output?: { text?: string } | string } | undefined;
  if (i?.type !== 'function_call_result') return undefined;
  return typeof i.output === 'string' ? i.output : i.output?.text;
}

export class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly script: Script,
    private readonly usage = { inputTokens: 100, outputTokens: 20 },
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const input = typeof request.input === 'string' ? [] : request.input;
    const output = this.script(request, {
      call: this.requests.length,
      toolNames: request.tools.map((t) => t.name),
      lastItem: input.at(-1),
    });
    return {
      output,
      usage: new Usage({
        requests: 1,
        inputTokens: this.usage.inputTokens,
        outputTokens: this.usage.outputTokens,
        totalTokens: this.usage.inputTokens + this.usage.outputTokens,
      }),
      responseId: `resp_${this.requests.length}`,
    };
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error('ScriptedModel does not stream');
  }
}
