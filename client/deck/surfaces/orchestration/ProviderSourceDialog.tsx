import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { orchestrationProviderSourceRpc } from "../../../../shared/orchestration-rpc.ts";
import type { PanelTextFn } from "../../panel/panelText.tsx";
import { ProviderSourceModal } from "./ProviderSourceModal.tsx";
import type { PixelSkin } from "../../pixel.tsx";

type SourceResult = RpcOutput<typeof orchestrationProviderSourceRpc>;
type SourceGeneration = { provider: string; request: number };
type SourceState = { provider: string | null; loading: boolean; error: string | null; result: SourceResult | null };

function emptySourceState(provider: string | null): SourceState {
  return { provider, loading: provider !== null, error: null, result: null };
}

function useProviderSource(provider: string | null) {
  const readSource = useRpc(orchestrationProviderSourceRpc);
  const generation = useRef<SourceGeneration | null>(null);
  const [state, setState] = useState<SourceState>(() => emptySourceState(provider));

  useLayoutEffect(() => {
    const current = provider === null ? null : { provider, request: 0 };
    generation.current = current;
    setState(emptySourceState(provider));
    return () => {
      if (generation.current === current) generation.current = null;
    };
  }, [provider]);

  const refresh = useCallback(() => {
    const owner = generation.current;
    if (!provider || !owner || owner.provider !== provider) return;
    const request = ++owner.request;
    const isCurrent = () => generation.current === owner && owner.request === request;
    setState((current) => current.provider === provider
      ? { ...current, loading: true, error: null }
      : current);
    void readSource({ provider }).then(
      (result) => {
        if (isCurrent()) setState({ provider, loading: false, error: null, result });
      },
      (error: unknown) => {
        if (isCurrent()) setState((current) => current.provider === provider
          ? { ...current, loading: false, error: error instanceof Error ? error.message : String(error) }
          : current);
      },
    );
  }, [provider, readSource]);

  useEffect(() => {
    if (provider !== null) refresh();
  }, [provider, refresh]);

  const current = state.provider === provider ? state : emptySourceState(provider);
  return { ...current, refresh };
}

/** Owns source-read state and request lifetime for one open provider dialog. */
export function ProviderSourceDialog({
  skin, t, provider, onClose, onChanged,
}: {
  skin: PixelSkin;
  t: PanelTextFn;
  provider: string | null;
  onClose(): void;
  onChanged(): void;
}) {
  const source = useProviderSource(provider);
  return <ProviderSourceModal
    skin={skin}
    t={t}
    open={provider !== null}
    provider={provider ?? ""}
    loading={source.loading}
    error={source.error}
    result={source.result}
    onClose={onClose}
    onRefresh={source.refresh}
    onChanged={onChanged}
  />;
}
