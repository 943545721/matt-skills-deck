import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { CheckAction, CheckField } from "../../../shared/checks";
import { PixelButton, PixelModalBody, usePixel, type PixelSkin } from "../pixel";
import type { PanelTextFn } from "./panelText";

/**
 * 检查动作的通用表单 / 向导弹窗。
 *
 * 字段与校验语义照 DSH 的 fix contract：
 * - `required` 为空不许往下走；`pattern` 不通过停在当前步并提示；
 * - `defaultFrom: "cwd-basename"` 把工作区目录最后一段清洗成合法仓库名当默认值；
 * - `preview` 随值实时渲染，`{owner}` / `{name}` 两个占位符；
 * - 向导把各步的值用 Object.assign 合并成一个对象，提交时原样交给 submitAction，
 *   并补上 `cwd`（DSH 的 submitAction 合并约定）。
 *
 * 本组件只管「把值收齐」；收齐之后干什么由调用方给 submit 回调决定（注入提示词 /
 * 调 RPC / 保存设置），组件不认识任何具体动作。
 */

export interface WizardStepSpec {
  key: string;
  title: string;
  schema: readonly CheckField[];
}

export interface CheckActionModalProps {
  theme: PluginTheme;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** 弹窗标题（动作自己的 label 或向导名）。 */
  title: string;
  /** form 形态：单层字段。 */
  form?: { schema: readonly CheckField[] } | null;
  /** wizard 形态：多步；与 form 二选一。 */
  wizard?: { steps: readonly WizardStepSpec[] } | null;
  /** 工作区目录：cwd-basename 默认值与提交时的 cwd 都从这里来。 */
  workspaceDir: string;
  /** `{owner}` 预览占位符；读不到登录账号时给空串，预览照常渲染。 */
  owner: string;
  /** 面板文案函数（只取通用键：返回 / 下一步 / 提交 / 必填 / 格式错误 / 目录 / 文件等）。 */
  t: PanelTextFn;
  /** 收齐全部值后回调；返回 false 表示提交失败、不关窗（调用方自己弹 toast）。 */
  submit(values: Record<string, string>): Promise<boolean> | boolean;
}

/**
 * DSH 的 cwd-basename 清洗：目录最后一段 → 小写 → 非法字符折成 - → 收掉首尾 . 与 -。
 *
 * 与 DSH 的有意偏移：DSH 保大小写、清洗不出合法值就不预填（留 placeholder）；
 * 这里统一小写（GitHub 仓库名不分大小写，小写更稳）且必给兜底值——清洗结果不合法时
 * 由字段 pattern 与 publish 的 bad-name 档位拦截，预填一个可见的坏值比静默留空
 * 更容易被用户发现并改掉。
 */
export function defaultFromCwd(workspaceDir: string): string {
  const base = (workspaceDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "").trim();
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned || base || "repo";
}

function renderPreview(template: string, owner: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (name === "owner") return owner || "owner";
    return values[name]?.trim() || match;
  });
}

function fieldLabel(field: CheckField): string {
  return field.label ?? field.name;
}

function initialValues(
  fields: readonly CheckField[],
  workspaceDir: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    if (field.defaultFrom === "cwd-basename") out[field.name] = defaultFromCwd(workspaceDir);
    else if (field.defaultValue !== undefined) out[field.name] = field.defaultValue;
    else out[field.name] = "";
  }
  return out;
}

function invalidReason(field: CheckField, value: string, t: PanelTextFn): string | null {
  const trimmed = value.trim();
  if (field.required && !trimmed) return t("checks.form.required", { field: fieldLabel(field) });
  if (field.pattern && trimmed) {
    try {
      if (!new RegExp(`^(?:${field.pattern})$`).test(trimmed)) {
        return t("checks.form.pattern", { field: fieldLabel(field) });
      }
    } catch {
      // 契约里的正则写错了：不拦用户，但把错误露出来，别静默吞掉。
      return t("checks.form.badPattern", { pattern: field.pattern });
    }
  }
  return null;
}

function FieldEditor({
  skin,
  field,
  value,
  values,
  owner,
  disabled,
  t,
  onChange,
}: {
  skin: PixelSkin;
  field: CheckField;
  value: string;
  values: Record<string, string>;
  owner: string;
  disabled: boolean;
  t: PanelTextFn;
  onChange(next: string): void;
}) {
  const styles = useMemo(
    () => ({
      field: { gap: 4 },
      label: { ...skin.label, color: skin.colors.ink },
      options: { flexDirection: "row" as const, gap: 6, flexWrap: "wrap" as const },
      preview: { ...skin.hint, fontFamily: skin.mono.fontFamily, fontSize: 11 },
      note: skin.hint,
    }),
    [skin],
  );
  const kind = field.type ?? "text";
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{fieldLabel(field)}</Text>
      {kind === "single" || kind === "multi" ? (
        <View style={styles.options}>
          {(field.options ?? []).map((option) => {
            const sub = field.optionSubs?.[option];
            const active =
              kind === "single"
                ? value === option
                : value
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean)
                    .includes(option);
            return (
              <PixelButton
                key={option}
                skin={skin}
                variant="tab"
                label={sub ?? option}
                accessibilityLabel={sub ?? option}
                active={active}
                disabled={disabled}
                onPress={() => {
                  if (kind === "single") {
                    onChange(option);
                    return;
                  }
                  const current = value
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean);
                  const next = active ? current.filter((item) => item !== option) : [...current, option];
                  onChange(next.join(","));
                }}
              />
            );
          })}
        </View>
      ) : (
        <TextInput
          accessibilityLabel={fieldLabel(field)}
          style={skin.input}
          value={value}
          onChangeText={onChange}
          editable={!disabled}
          placeholder={field.placeholder ?? (kind === "directory" ? t("checks.form.dirPlaceholder") : kind === "file" ? t("checks.form.filePlaceholder") : undefined)}
          placeholderTextColor={skin.colors.ink2}
          multiline={false}
        />
      )}
      {field.preview ? <Text style={styles.preview}>{renderPreview(field.preview, owner, values)}</Text> : null}
      {kind === "directory" || kind === "file" ? (
        <Text style={styles.note}>{t("checks.form.pathNote")}</Text>
      ) : null}
    </View>
  );
}

export function CheckActionModal(props: CheckActionModalProps) {
  const { theme, open, onOpenChange, title, form, wizard, workspaceDir, owner, t, submit } = props;
  const skin = usePixel(theme);

  const steps: readonly WizardStepSpec[] = useMemo(() => {
    if (wizard) return wizard.steps;
    if (form) return [{ key: "form", title, schema: form.schema }];
    return [];
  }, [wizard, form, title]);

  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 每次打开都重置：上一次的输入不能带进下一次（DSH 同样每次重开都是新表单）。
  useEffect(() => {
    if (!open) return;
    const allFields = steps.flatMap((step) => step.schema);
    setValues(initialValues(allFields, workspaceDir));
    setStepIndex(0);
    setError(null);
    setBusy(false);
    // workspaceDir 变化时下一个打开周期会重新初始化；steps 由调用方给定，引用可能每轮新建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceDir]);

  if (!open || steps.length === 0) {
    return <Modal title={title} open={open} onOpenChange={onOpenChange}><Modal.Content><View /></Modal.Content></Modal>;
  }

  const step = steps[Math.min(stepIndex, steps.length - 1)] ?? steps[0];
  const isLast = stepIndex >= steps.length - 1;
  if (!step) {
    return <Modal title={title} open={open} onOpenChange={onOpenChange}><Modal.Content><View /></Modal.Content></Modal>;
  }

  /** DSH 的跳回规则：找到第一个不过的字段，跳回它所在的那一步并提示。 */
  const validateStep = (index: number): string | null => {
    const target = steps[index];
    if (!target) return null;
    for (const field of target.schema) {
      const reason = invalidReason(field, values[field.name] ?? "", t);
      if (reason) return reason;
    }
    return null;
  };

  const goNext = () => {
    const reason = validateStep(stepIndex);
    if (reason) {
      setError(reason);
      return;
    }
    setError(null);
    setStepIndex((current) => Math.min(current + 1, steps.length - 1));
  };

  const goBack = () => {
    setError(null);
    setStepIndex((current) => Math.max(current - 1, 0));
  };

  const doSubmit = async () => {
    // 提交前把每一步都过一遍；有不过的字段就跳回那一步（wizard 的 jump-back）。
    for (let index = 0; index < steps.length; index += 1) {
      const reason = validateStep(index);
      if (reason) {
        setStepIndex(index);
        setError(reason);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      // submitAction 合并约定：params + 各步字段 + cwd，一次给全。
      const merged: Record<string, string> = Object.assign({}, values, { cwd: workspaceDir });
      const ok = await submit(merged);
      if (ok) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const styles = {
    body: { gap: 10 },
    stepTitle: { ...skin.head },
    progress: skin.hint,
    error: skin.error,
    actions: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const, flexWrap: "wrap" as const },
  };

  return (
    <Modal title={title} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <PixelModalBody skin={skin} style={styles.body}>
          {steps.length > 1 ? (
            <>
              <Text style={styles.stepTitle}>{step.title}</Text>
              <Text style={styles.progress}>{t("checks.wizard.progress", { index: stepIndex + 1, total: steps.length })}</Text>
            </>
          ) : null}
          {step.schema.map((field) => (
            <FieldEditor
              key={field.name}
              skin={skin}
              field={field}
              value={values[field.name] ?? ""}
              values={values}
              owner={owner}
              disabled={busy}
              t={t}
              onChange={(next) => setValues((current) => ({ ...current, [field.name]: next }))}
            />
          ))}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            {stepIndex > 0 ? (
              <PixelButton skin={skin} label={t("checks.wizard.back")} disabled={busy} onPress={goBack} />
            ) : null}
            {isLast ? (
              <PixelButton
                skin={skin}
                variant="solid"
                label={busy ? t("checks.wizard.submitting") : t("checks.wizard.submit")}
                disabled={busy}
                onPress={() => void doSubmit()}
              />
            ) : (
              <PixelButton skin={skin} variant="solid" label={t("checks.wizard.next")} disabled={busy} onPress={goNext} />
            )}
            <PixelButton
              skin={skin}
              label={t("common.cancel")}
              disabled={busy}
              onPress={() => onOpenChange(false)}
            />
          </View>
        </PixelModalBody>
      </Modal.Content>
    </Modal>
  );
}
