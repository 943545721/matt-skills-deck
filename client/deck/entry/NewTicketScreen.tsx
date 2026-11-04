import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { repoTargetsRpc } from "../../../shared/repo";
import type { NewIssueRepo } from "../../../shared/new-issue";
import { useDeckText } from "../i18n";
import { NewIssueModal } from "../NewIssueModal";
import { usePixel } from "../pixel";

/**
 * 整页建票表单：`/deck new` 打开的落点。
 *
 * 为什么不复用面板里的浮层：斜杠命令拿不到面板的句柄（`openPanel` 只能把面板打开，
 * 不能告诉它「弹出新建票」）。整页界面能带参数，`params.dir` 就是工作区目录，
 * 所以这里读同一份仓库清单、渲染同一份表单（`NewIssueModal` 的 inline 模式），
 * 不另写一套字段。
 *
 * 面板里的提交流程仍然走 `issuesCreateRpc`：这里不新增 RPC，也不在客户端拼标签。
 */
export function DeckNewTicketScreen({ theme, params }: PluginScreenProps) {
  const skin = usePixel(theme);
  const { t } = useDeckText();
  const workspaceDir = (params.dir ?? "").trim();
  const readTargets = useRpc(repoTargetsRpc);
  const targets = useQuery({
    queryKey: ["deck", "repo-targets", workspaceDir],
    queryFn: () => readTargets({ workspaceDir }),
    staleTime: 30_000,
    enabled: workspaceDir.length > 0,
  });

  if (!workspaceDir) {
    return (
      <View style={{ padding: 20 }}>
        <Text style={{ color: skin.colors.ink2, fontSize: 12 }}>{t("new.noWorkspace")}</Text>
      </View>
    );
  }

  const repos: NewIssueRepo[] = targets.data?.ok
    ? targets.data.repos.map((repo) => ({ key: repo.key, name: repo.name, readOnly: repo.readOnly }))
    : [];
  const defaultRepoKey = targets.data?.ok ? targets.data.defaultKey : null;

  return (
    <View style={{ flex: 1 }}>
      <NewIssueModal
        theme={theme}
        workspaceDir={workspaceDir}
        repos={repos}
        defaultRepoKey={defaultRepoKey}
        open
        inline
        onClose={() => undefined}
      />
    </View>
  );
}
