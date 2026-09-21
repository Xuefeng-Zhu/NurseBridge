# Compatibility baseline

Verified package metadata on 2026-09-21; successful installation/build/runtime checks are recorded separately in test-results.md.

| Component | Pin |
| --- | --- |
| Node / pnpm | 24.14.1 / 11.19.0 |
| Next / React | 16.3.5 / 19.3.0 |
| OpenNext Cloudflare / Wrangler | 1.20.6 / 4.135.0 |
| TypeScript / Tailwind | 5.9.3 / 4.3.3 |
| Zod / Vitest | 4.6.5 / 4.1.4 |
| Cloudflare Vitest plugin / Playwright | 1.1.13 / 1.60.0 |
| Workers compatibility date | 2026-09-18 |

OpenNext accepts Next >=15.5.24 <16 or >=16.3.3. Manual configuration intentionally retains the Next build; automatic Wrangler setup can select vinext. Current Cloudflare testing uses `@cloudflare/vitest-plugin`, not older pool-worker configuration. Workspace dependencies are locked in pnpm-lock.yaml. esbuild is pinned to the compatible Vite peer version; native build permissions are explicit in pnpm-workspace.yaml.

Local preview uses [Wrangler multi-Worker development](https://developers.cloudflare.com/workers/local-development/multi-workers/) so web and realtime share a single D1/R2 emulator authority. Separate Wrangler processes against the same persistence directory produced intermittent local D1 internal errors under concurrent activity. A local-only gateway and loopback realtime proxy preserve the two public test ports; neither is deployed.

Workers outbound WebSockets explicitly set binaryType=arraybuffer before accept; recent compatibility dates otherwise default to Blob. Workers do not promise browser bufferedAmount semantics, so audio has application acknowledgments/credits. SQLite DO transactions are synchronous and cannot cross network awaits.

AssemblyAI Voice Agent uses a Workers-native authenticated WebSocket with 24 kHz mono PCM16. The adapter verifies the returned audio/model configuration before forwarding audio, then applies the workspace template/tools and verifies the update. Stored-agent configuration is pinned per call. Conversation uses Nebius Nemotron-3.5-Lightning streaming tool calls; independent extraction retains non-streaming JSON schema output and Zod/evidence validation. Both require live verification.

Cloudflare Workers AI is no longer a runtime dependency. The former standalone STT/Aura-2 adapter files and format tests remain as legacy utilities only; CallSession does not import them. Existing 16 kHz DSP tests remain useful compatibility tests while current transport acceptance uses 24 kHz.

Account recording retention, actual provider deletion behavior, and end-to-end conversation are pending. The documented session DELETE is soft deletion and does not by itself establish seven-day physical purge. Live activation remains blocked. See voice-agent.md for the verified wire contract and explicit setup instructions.

Primary sources: [OpenNext setup](https://opennext.js.org/cloudflare/get-started), [bindings](https://opennext.js.org/cloudflare/bindings), [Cloudflare framework guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/), [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [Voice Agent events](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference), [custom LLM](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm), [client tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools), [Nebius chat completions](https://docs.tokenfactory.nebius.com/api-reference/inference/create-chat-completion), [Nebius structured output](https://docs.tokenfactory.nebius.com/ai-models-inference/json), [Nebius model listing](https://docs.tokenfactory.nebius.com/api-reference/models/list-models), [provider session deletion](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-history#delete-a-session).
