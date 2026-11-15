import { useState } from "react";
import type { PanelTextFn } from "../../panel/panelText.tsx";

type ProviderNotice = { provider: string; bad: boolean; text: string };

/**
 * 诊断 / 安装的进行状态与结果。
 *
 * 结果按 provider 归属：A 卡片的安装输出不会跑到 B 卡片上。安装前的二次确认
 * 也在这里，确认后立即清掉确认态，避免按钮在等待期间仍显示「确认执行」。
 */
export function useProviderDiagnostics({
  t,
  diagnose,
  install,
}: {
  t: PanelTextFn;
  diagnose(provider: string): Promise<{ ok: true; diagnostic: string } | { ok: false; detail: string }>;
  install(provider: string): Promise<{ ok: true; output: string } | { ok: false; detail: string; output?: string }>;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [diagnosingId, setDiagnosingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<ProviderNotice | null>(null);

  const runDiagnose = async (provider: string) => {
    setDiagnosingId(provider);
    setNotice(null);
    try {
      const result = await diagnose(provider);
      setNotice({ provider, bad: !result.ok, text: result.ok ? result.diagnostic : result.detail });
    } finally {
      setDiagnosingId(null);
    }
  };

  const runInstall = async (provider: string) => {
    setConfirmId(null);
    setInstallingId(provider);
    setNotice(null);
    try {
      const result = await install(provider);
      setNotice({
        provider,
        bad: !result.ok,
        text: result.ok
          ? [t("orch.installOk", { provider }), result.output].filter(Boolean).join("\n\n")
          : [result.detail, result.output ?? ""].filter(Boolean).join("\n\n"),
      });
    } finally {
      setInstallingId(null);
    }
  };

  return {
    confirmingFor: (provider: string) => confirmId === provider,
    anyInstalling: installingId !== null,
    diagnosingFor: (provider: string) => diagnosingId === provider,
    noticeFor: (provider: string) => (notice?.provider === provider ? notice : null),
    setConfirmId,
    diagnose: runDiagnose,
    install: runInstall,
  };
}

export type ProviderDiagnostics = ReturnType<typeof useProviderDiagnostics>;
