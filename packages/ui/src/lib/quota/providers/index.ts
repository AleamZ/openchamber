import { isVSCodeRuntime } from '@/lib/desktop';
import type { QuotaProviderId } from '@/types';

interface QuotaProviderMeta {
  id: QuotaProviderId;
  name: string;
}

const ALL_QUOTA_PROVIDERS: readonly QuotaProviderMeta[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'cline-pass', name: 'ClinePass' },
  { id: 'codex', name: 'Codex' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'github-copilot', name: 'GitHub Copilot' },
  { id: 'google', name: 'Google' },
  { id: 'kimi-for-coding', name: 'Kimi for Coding' },
  { id: 'nano-gpt', name: 'NanoGPT' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'zai-coding-plan', name: 'z.ai' },
  { id: 'zhipuai-coding-plan', name: 'Zhipu AI Coding Plan' },
  { id: 'minimax-cn-coding-plan', name: 'MiniMax Coding Plan (minimaxi.com)' },
  { id: 'minimax-coding-plan', name: 'MiniMax Coding Plan (minimax.io)' },
  { id: 'ollama-cloud', name: 'Ollama Cloud' },
  { id: 'wafer', name: 'Wafer.ai' },
  { id: 'opencode-go', name: 'OpenCode Go' },
  { id: 'deepinfra', name: 'DeepInfra' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'exe-dev', name: 'exe.dev' },
  { id: 'hyper', name: 'Charm Hyper' },
  { id: 'neuralwatt', name: 'NeuralWatt' },
  { id: 'kilo', name: 'Kilo Code' },
  { id: 'zenmux', name: 'ZenMux' },
  { id: '9router', name: '9Router' },
  { id: 'xai', name: 'xAI' },
];

// The VS Code runtime cannot save 9router credentials; hide 9Router until parity is supported.
export const QUOTA_PROVIDERS: QuotaProviderMeta[] = isVSCodeRuntime()
  ? ALL_QUOTA_PROVIDERS.filter((provider) => provider.id !== '9router')
  : [...ALL_QUOTA_PROVIDERS];
