import { useEffect, useState } from 'react';
import AI_CONFIG from '../config/aiProviders.json';
import { OPENAI_COMPAT_PROVIDERS } from './aiProviders';

// Display names for provider ids — the same sources the AI Provider settings use.
const LABELS = {
  ...Object.fromEntries(Object.entries(AI_CONFIG.PROVIDER_INFO || {}).map(([id, v]) => [id, v.name])),
  ...Object.fromEntries(Object.entries(OPENAI_COMPAT_PROVIDERS).map(([id, v]) => [id, v.name])),
};

/**
 * The user's Default Embedding Model from Settings → AI Provider, for node
 * panels that show which model a step embeds with. Read from the main process.
 *
 * @returns {{ defaults: { provider, model, dimensions }, labels: Object<string,string> }}
 */
export default function useEmbeddingDefault() {
  const [defaults, setDefaults] = useState({ provider: null, model: null, dimensions: null });

  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== 'undefined' ? window.electronAPI?.ai : null;
    if (!api?.getEmbeddingDefault) return undefined;
    api.getEmbeddingDefault()
      .then((d) => {
        if (!cancelled) setDefaults({ provider: d?.provider || null, model: d?.model || null, dimensions: d?.dimensions || null });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return { defaults, labels: LABELS };
}

/**
 * Provider of a model saved before nodes stored one. OpenAI was the only
 * embedding provider then, so any saved model with no provider is OpenAI's.
 */
export function inferEmbeddingProvider(model) {
  return model ? 'openai' : null;
}
