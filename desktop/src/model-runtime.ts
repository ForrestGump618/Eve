/** Mutable model configuration + the typed `ModelCaller` used by activities. */
import { modelReply, modelTurn, validateModelConfig, type ModelConfig, type TurnMessage, type FunctionSpec, type ModelTurn } from './providers.js';
import { ValidationError, type Json } from './harness/types.js';
import type { ModelCaller, ModelMessage } from './shared/contract.js';

export class ModelRuntime implements ModelCaller {
  private config: ModelConfig | null = null;
  configure(input: unknown): ModelConfig {
    const config = validateModelConfig(input);
    this.config = config;
    return config;
  }
  current(): ModelConfig | null { return this.config; }
  fork():ModelRuntime { const runtime=new ModelRuntime();if(this.config)runtime.configure({...this.config});return runtime; }
  configured(): boolean { return this.config !== null; }
  contextWindow(): number { return this.config?.contextWindow ?? 128_000; }
  model(): string | null { return this.config?.model ?? null; }
  outputTokens(): number { return this.config?.maxOutput ?? 4096; }
  provider(): string | null { return this.config?.provider ?? null; }
  publicConfig(): Json {
    const config = this.config;
    return config ? { provider: config.provider, model: config.model, baseUrl: config.baseUrl, contextWindow: config.contextWindow, maxOutput: config.maxOutput, temperature: config.temperature, modalities: [...config.modalities], tokenParameter:config.tokenParameter??'max_tokens' } : null;
  }
  async turn(messages: TurnMessage[], tools: FunctionSpec[], signal: AbortSignal, onText?: (text:string)=>void): Promise<ModelTurn> {
    const config=this.config;
    if(!config)throw new ValidationError('模型凭据未解锁。请打开设置保存配置后恢复任务。');
    return modelTurn(config,messages,signal,onText??(()=>{}),tools);
  }
  async call(messages: ModelMessage[], signal: AbortSignal, onText?: (text: string) => void): Promise<{ text: string; tokens: number }> {
    const config = this.config;
    if (!config) throw new ValidationError('模型凭据未解锁。请打开设置保存配置后恢复任务。');
    const result = await modelReply(config, messages as Array<{ role: string; content: string }>, signal, onText ?? (() => {}));
    return { text: result.text, tokens: result.tokens };
  }
}
