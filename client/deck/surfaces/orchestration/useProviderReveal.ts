import { useState } from "react";

type RevealedValue = { provider: string; key: string; value: string | null; bad: string | null };

/**
 * 当前展开着原值的那一个键。
 *
 * 原值只活在这张卡片里：切到别的键、收起卡片或换 provider 都会清掉。
 * 一次只取回一个键，不落状态快照、不进日志。
 */
export function useProviderReveal(
  onReveal: (provider: string, key: string) => Promise<{ ok: true; value: string } | { ok: false; detail: string }>,
) {
  const [revealed, setRevealed] = useState<RevealedValue | null>(null);
  const [busy, setBusy] = useState(false);

  const show = async (provider: string, key: string) => {
    setBusy(true);
    try {
      const result = await onReveal(provider, key);
      setRevealed(
        result.ok
          ? { provider, key, value: result.value, bad: null }
          : { provider, key, value: null, bad: result.detail },
      );
    } finally {
      setBusy(false);
    }
  };

  return {
    currentFor: (provider: string) => (revealed?.provider === provider ? revealed : null),
    busy,
    show,
    hide: () => setRevealed(null),
  };
}

export type ProviderReveal = ReturnType<typeof useProviderReveal>;
