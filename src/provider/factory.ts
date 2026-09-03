import {
  OpenAIChatProvider,
  type OpenAIChatProviderOptions,
} from '#/provider/openai/chat-completions';
import type { ChatProvider } from '#/provider/types';

export interface OpenAIProviderConfig extends OpenAIChatProviderOptions {
  type: 'openai';
}

export type ProviderConfig = OpenAIProviderConfig;

export function createProvider(config: ProviderConfig): ChatProvider {
  switch (config.type) {
    case 'openai':
      return new OpenAIChatProvider(config);
  }
}
