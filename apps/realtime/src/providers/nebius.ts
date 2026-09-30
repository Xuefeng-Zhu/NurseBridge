import type { Extraction } from '@nursebridge/contracts';
import { extractChat, ExtractionError, type ChatExtractionOptions, type ChatExtractionProvider, type ExtractionErrorCode, type ProviderFetch } from './chat-extraction';

// Keep the public Nebius contract stable while sharing validation and bounds.
export const NEBIUS_CHAT_URL = 'https://api.tokenfactory.nebius.com/v1/chat/completions';
export const DEFAULT_EXTRACTION_MODEL = 'nvidia/Nemotron-3_5-Lightning';
export type NebiusExtractionErrorCode = ExtractionErrorCode;
export class NebiusExtractionError extends ExtractionError {
  constructor(code: NebiusExtractionErrorCode, message: string) {
    super(code, message);
    this.name = 'NebiusExtractionError';
  }
}
export type NebiusOptions = ChatExtractionOptions;
export type { ProviderFetch } from './chat-extraction';

const provider: ChatExtractionProvider = {
  label: 'Nebius', endpoint: NEBIUS_CHAT_URL, defaultModel: DEFAULT_EXTRACTION_MODEL,
  authorization: 'bearer', Error: NebiusExtractionError,
  // Nemotron defaults to reasoning; reserve the completion budget for JSON.
  requestParameters: { chat_template_kwargs: { enable_thinking: false }, n: 1, store: false },
};

export function extract(options: NebiusOptions, input: unknown, request: ProviderFetch = fetch): Promise<Extraction> {
  return extractChat(provider, options, input, request);
}
