import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  issuesAssignRpc,
  issuesCommentRpc,
  issuesCreateRpc,
  issuesDetailRpc,
  issuesListRpc,
  issuesSetLabelsRpc,
  issuesStateRpc,
} from "../../shared/issues.ts";
import { labelsColorsRpc, labelsListRpc } from "../../shared/labels.ts";
import { mapRpc } from "../../shared/map.ts";
import { logsClearRpc, logsRpc } from "../../shared/logs.ts";
import { envCheckRpc } from "../../shared/env.ts";
import { envCheckHandler } from "./env.ts";
import { updateCheckRpc } from "../../shared/update.ts";
import { checkForUpdate } from "../update.ts";
import { listLogs, resetLogs } from "../logs.ts";
import { skillsInstallRpc, skillsListRpc, skillsReadRpc } from "../../shared/skills.ts";
import { statusRpc } from "../../shared/status.ts";
import {
  gitCheckRpc,
  gitCommitRpc,
  gitDiffRpc,
  gitFetchRpc,
  gitLogRpc,
  gitPullRpc,
  gitPushRpc,
  gitStageRpc,
  gitStatusRpc,
  gitUnstageRpc,
} from "../../shared/git.ts";
import {
  assignIssueHandler,
  commentIssueHandler,
  createIssueHandler,
  getIssueHandler,
  listIssuesHandler,
  setIssueLabelsHandler,
  setIssueStateHandler,
} from "./issues.ts";
import { listLabelsHandler, setLabelColorsHandler } from "./labels.ts";
import { mapHandler } from "./map.ts";
import { listSkills, installSkillsHandler, readSkill } from "./skills.ts";
import { readStatus } from "../status.ts";
import {
  gitCheckHandler,
  gitCommitHandler,
  gitDiffHandler,
  gitFetchHandler,
  gitLogHandler,
  gitPullHandler,
  gitPushHandler,
  gitStageHandler,
  gitStatusHandler,
  gitUnstageHandler,
} from "./git.ts";

/**
 * 全部 RPC 的注册表。
 *
 * 单独一个文件是为了让入口保持「一眼看完」：入口只回答「怎么挂上去」，
 * 这里回答「挂了哪些」，实现各归各家。加一个域只改这一处，不碰入口。
 */
export function registerAll(server: PluginServerContext): void {
  server.handle(statusRpc, readStatus);

  server.handle(skillsListRpc, listSkills);
  server.handle(skillsInstallRpc, installSkillsHandler);
  server.handle(skillsReadRpc, readSkill);

  server.handle(issuesListRpc, listIssuesHandler);
  server.handle(issuesDetailRpc, getIssueHandler);
  server.handle(issuesCommentRpc, commentIssueHandler);
  server.handle(issuesCreateRpc, createIssueHandler);
  server.handle(issuesSetLabelsRpc, setIssueLabelsHandler);
  server.handle(issuesAssignRpc, assignIssueHandler);
  server.handle(issuesStateRpc, setIssueStateHandler);

  server.handle(mapRpc, mapHandler);

  server.handle(labelsListRpc, listLabelsHandler);
  server.handle(labelsColorsRpc, setLabelColorsHandler);

  server.handle(gitStatusRpc, gitStatusHandler);
  server.handle(gitDiffRpc, gitDiffHandler);
  server.handle(gitLogRpc, gitLogHandler);
  server.handle(gitCheckRpc, gitCheckHandler);
  server.handle(gitStageRpc, gitStageHandler);
  server.handle(gitUnstageRpc, gitUnstageHandler);
  server.handle(gitCommitRpc, gitCommitHandler);
  server.handle(gitPullRpc, gitPullHandler);
  server.handle(gitFetchRpc, gitFetchHandler);
  server.handle(gitPushRpc, gitPushHandler);

  server.handle(logsRpc, (input) => ({ entries: listLogs(input.limit) }));
  server.handle(logsClearRpc, () => {
    // 先数再清：界面要能说「清掉了 N 条」，否则用户不确定那一下有没有生效。
    const cleared = listLogs(200).length;
    resetLogs();
    return { cleared };
  });
  server.handle(envCheckRpc, envCheckHandler);
  server.handle(updateCheckRpc, () => checkForUpdate());
}
