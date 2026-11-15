import { useState } from "react";

type SiteDraft = { id: string; label: string; baseUrl: string; credential: string };
type SiteForm = { provider: string; id: string };
type SiteSaveInput = {
  provider: string;
  site?: { id: string; label?: string; baseUrl: string; credential?: string };
  removeId?: string;
  enableId?: string;
};
type SiteSave = (input: SiteSaveInput) => Promise<{ ok: true } | { ok: false; detail: string }>;

const EMPTY_DRAFT: SiteDraft = { id: "", label: "", baseUrl: "", credential: "" };

const draftOf = (site: { id: string; label?: string | null; baseUrl: string } | null): SiteDraft => ({
  id: site?.id ?? "",
  label: site?.label ?? "",
  baseUrl: site?.baseUrl ?? "",
  credential: "",
});

/** 表单 → RPC 入参；必填项不齐时返回 null，界面据此不发请求。 */
function siteSaveInputOf(form: SiteForm, draft: SiteDraft): SiteSaveInput | null {
  const editingSite = Boolean(form.id);
  const id = editingSite ? form.id : draft.id.trim().toLowerCase();
  if (!id || !draft.baseUrl.trim()) return null;
  return {
    provider: form.provider,
    site: {
      id,
      ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
      baseUrl: draft.baseUrl.trim(),
      ...(draft.credential ? { credential: draft.credential } : {}),
    },
  };
}

/**
 * 客户端下的站点表单：一次只开一个客户端的表单，`id` 为空表示新增。
 *
 * 改地址时不必把凭证再贴一遍：留空就是沿用这条站点已存的那份（服务端也是这么理解的）。
 * 校验统一交给服务端——它给出的原因和落盘时的判定是同一套，界面不另写一份。
 */
export function useSiteEditor(onSaveSite: SiteSave) {
  const [form, setForm] = useState<SiteForm | null>(null);
  const [draft, setDraft] = useState<SiteDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<{ provider: string; text: string } | null>(null);

  const close = () => {
    setForm(null);
    setDraft(EMPTY_DRAFT);
    setBad(null);
  };

  const open = (provider: string, site: { id: string; label?: string | null; baseUrl: string } | null) => {
    setBad(null);
    setForm({ provider, id: site?.id ?? "" });
    setDraft(draftOf(site));
  };

  const save = async () => {
    if (!form) return;
    const input = siteSaveInputOf(form, draft);
    if (!input) return;
    setBusy(true);
    setBad(null);
    try {
      const result = await onSaveSite(input);
      if (!result.ok) {
        setBad({ provider: form.provider, text: result.detail });
        return;
      }
      close();
    } finally {
      setBusy(false);
    }
  };

  /** 启用与删除共用一条路径：错误只显示在它所属的那张卡片上。 */
  const run = async (provider: string, action: { enableId?: string; removeId?: string }) => {
    setBusy(true);
    setBad(null);
    try {
      const result = await onSaveSite({ provider, ...action });
      if (!result.ok) setBad({ provider, text: result.detail });
    } finally {
      setBusy(false);
    }
  };

  return {
    formFor: (provider: string) => (form?.provider === provider ? form : null),
    draft,
    change: setDraft,
    busy,
    errorFor: (provider: string) => (bad?.provider === provider ? bad.text : null),
    open,
    close,
    save,
    enable: (provider: string, id: string) => run(provider, { enableId: id }),
    remove: (provider: string, id: string) => run(provider, { removeId: id }),
  };
}

export type SiteEditor = ReturnType<typeof useSiteEditor>;
