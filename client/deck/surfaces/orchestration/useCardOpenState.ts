import { useState } from "react";
import type { FieldEditing } from "./useFieldEditing.ts";
import type { ProviderDiagnostics } from "./useProviderDiagnostics.ts";
import type { ProviderReveal } from "./useProviderReveal.ts";

/**
 * 卡片的展开状态：哪张展开、哪张的「高级」展开、配置源弹窗看着哪个客户端。
 *
 * 收起卡片要把明文、编辑态与安装确认一起丢掉；这些清理动作集中在这里，
 * 避免每个入口各写一遍、漏掉其中一项。
 */
export function useCardOpenState({
  editing,
  reveal,
  diagnostics,
}: {
  editing: FieldEditing;
  reveal: ProviderReveal;
  diagnostics: ProviderDiagnostics;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [advancedId, setAdvancedId] = useState<string | null>(null);
  const [sourceProvider, setSourceProvider] = useState<string | null>(null);

  const toggleOpen = (provider: string) => {
    // 收起时也把明文、编辑态与安装确认一起丢掉：下次展开要重新点「显示」，
    // 不把原值留在内存里。清理必须在分支之前，展开与收起都要执行。
    reveal.hide();
    editing.cancel();
    diagnostics.setConfirmId(null);
    setOpenId(openId === provider ? null : provider);
  };

  const toggleAdvanced = (provider: string) => {
    editing.cancel();
    setAdvancedId(advancedId === provider ? null : provider);
  };

  return {
    openFor: (provider: string) => openId === provider,
    advancedFor: (provider: string) => advancedId === provider,
    sourceProvider,
    toggleOpen,
    toggleAdvanced,
    openSource: setSourceProvider,
    closeSource: () => setSourceProvider(null),
  };
}

export type CardOpenState = ReturnType<typeof useCardOpenState>;
