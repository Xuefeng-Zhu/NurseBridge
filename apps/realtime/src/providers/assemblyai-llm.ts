import type { Extraction } from '@nursebridge/contracts';
import { extractChat, ExtractionError, type ChatExtractionOptions, type ChatExtractionProvider, type ProviderFetch } from './chat-extraction';

export const ASSEMBLYAI_CHAT_URL = 'https://llm-gateway.assemblyai.com/v1/chat/completions';
export const DEFAULT_ASSEMBLYAI_EXTRACTION_MODEL = 'qwen3.5-4b-32k-fast';
export type AssemblyAIExtractionOptions = ChatExtractionOptions;

const provider: ChatExtractionProvider = {
  label: 'AssemblyAI', endpoint: ASSEMBLYAI_CHAT_URL, defaultModel: DEFAULT_ASSEMBLYAI_EXTRACTION_MODEL,
  authorization: 'raw', Error: ExtractionError,
  // AssemblyAI's hosted Qwen accepts no response_format. Keep the complete
  // schema in the prompt and enforce JSON/Zod/evidence locally for every result.
  promptSchemaOnlyModels: ['qwen3.5-4b-32k-fast'],
  // The Gateway otherwise retries failures itself. The application owns its
  // single schema/evidence repair and never opts into a fallback model.
  requestParameters: { fallback_config: { retry: false } },
};

export function extractAssemblyAI(options: AssemblyAIExtractionOptions, input: unknown, request: ProviderFetch = fetch): Promise<Extraction> {
  return extractChat(provider, options, input, request);
}
