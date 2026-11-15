import { useState } from "react";

/**
 * 一张客户端卡片正在编辑哪个字段。
 *
 * `name` 是显示名，`env:<键>` 是某个环境变量。状态按 provider 记住字段名，
 * 但同一时刻只允许一个输入框处于编辑态：切到别的字段或收起卡片都会取消。
 */
export function useFieldEditing(onSave: {
  label(input: { provider: string; label: string }): void;
  env(input: { provider: string; env: Record<string, string> }): void;
}) {
  const [editing, setEditing] = useState<{ provider: string; field: string } | null>(null);
  const [draft, setDraft] = useState("");

  const start = (provider: string, field: string, initial: string) => {
    setEditing({ provider, field });
    setDraft(initial);
  };

  const cancel = () => {
    setEditing(null);
    setDraft("");
  };

  const save = (provider: string, field: string) => {
    if (!draft.trim()) return;
    if (field === "name") onSave.label({ provider, label: draft.trim() });
    else if (field.startsWith("env:")) onSave.env({ provider, env: { [field.slice(4)]: draft } });
    cancel();
  };

  return {
    fieldFor: (provider: string) => (editing?.provider === provider ? editing.field : null),
    draft,
    start,
    change: setDraft,
    save,
    cancel,
  };
}

export type FieldEditing = ReturnType<typeof useFieldEditing>;
