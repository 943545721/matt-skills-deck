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
import { authCancelRpc, authStartRpc, authStatusRpc, authTokenRpc } from "../../shared/auth.ts";
import { authCancelHandler, authStartHandler, authStatusHandler, authTokenHandler } from "./auth.ts";
import { repoCandidatesRpc, repoInfoRpc, repoSelectRpc, repoTargetsRpc } from "../../shared/repo.ts";
import { repoCandidatesHandler, repoInfoHandler, repoSelectHandler, repoTargetsHandler } from "./repo.ts";
import { updateCheckRpc } from "../../shared/update.ts";
import { checkForUpdate } from "../update.ts";
import { checksRunRpc } from "../../shared/checks-rpc.ts";
import { checksRunHandler } from "./checks.ts";
import { publishConfirmRpc, publishPlanRpc, publishRunRpc } from "../../shared/publish-rpc.ts";
import { publishConfirmHandler, publishPlanHandler, publishRunRpcHandler } from "./publish.ts";
import { sessionHandoffRpc, sessionHandoffsListRpc, sessionHandoffReadRpc, sessionLedgerRpc, sessionSendRpc } from "../../shared/session-rpc.ts";
import { sessionHandoffHandler, sessionHandoffsListHandler, sessionHandoffReadHandler, sessionLedgerHandler, sessionSendHandler } from "./session.ts";
import {
  orchestrationDispatchRpc,
  orchestrationProfileRpc,
  orchestrationProviderDiagnosticRpc,
  orchestrationProviderInstallRpc,
  orchestrationProviderModelsRpc,
  orchestrationProviderRevealRpc,
  orchestrationProviderRpc,
  orchestrationSaveRpc,
  orchestrationSiteRpc,
  orchestrationStateRpc,
} from "../../shared/orchestration-rpc.ts";
import {
  orchestrationDispatchHandler,
  orchestrationProfileHandler,
  orchestrationProviderDiagnosticHandler,
  orchestrationProviderInstallHandler,
  orchestrationProviderModelsHandler,
  orchestrationProviderRevealHandler,
  orchestrationProviderHandler,
  orchestrationSaveHandler,
  orchestrationSiteHandler,
  orchestrationStateHandler,
} from "./orchestration.ts";
import { issueAttachmentSearchRpc } from "../../shared/slash.ts";
import { workspaceBindingRpc } from "../../shared/workspace-binding.ts";
import { workspaceBindingHandler } from "./workspace.ts";
import { searchIssueAttachmentsHandler } from "./attachment.ts";
import { listLogs, resetLogs } from "../logs.ts";
import {
  skillsAdoptRpc,
  skillsInstallRpc,
  skillsListRpc,
  skillsReadRpc,
  skillsRemoveRpc,
} from "../../shared/skills.ts";
import { skillsDraftInstallRpc, skillsDraftRpc, skillsDraftValidateRpc } from "../../shared/skills-draft.ts";
import { skillsDraftHandler, skillsDraftInstallHandler, skillsDraftValidateHandler } from "./skills-draft.ts";
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
  gitWorktreesRpc,
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
import { adoptSkillHandler, listSkills, installSkillsHandler, readSkill, removeSkillsHandler } from "./skills.ts";
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
  gitWorktreesHandler,
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
  server.handle(skillsRemoveRpc, removeSkillsHandler);
  server.handle(skillsAdoptRpc, adoptSkillHandler);
  server.handle(skillsDraftRpc, skillsDraftHandler);
  server.handle(skillsDraftValidateRpc, skillsDraftValidateHandler);
  server.handle(skillsDraftInstallRpc, skillsDraftInstallHandler);

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
  server.handle(gitWorktreesRpc, gitWorktreesHandler);
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
  server.handle(authStatusRpc, authStatusHandler);
  server.handle(authStartRpc, authStartHandler);
  server.handle(authCancelRpc, authCancelHandler);
  server.handle(authTokenRpc, authTokenHandler);
  server.handle(repoInfoRpc, repoInfoHandler);
  server.handle(repoTargetsRpc, repoTargetsHandler);
  server.handle(repoCandidatesRpc, repoCandidatesHandler);
  server.handle(repoSelectRpc, repoSelectHandler);
  server.handle(updateCheckRpc, () => checkForUpdate());
  server.handle(checksRunRpc, checksRunHandler);
  server.handle(publishPlanRpc, publishPlanHandler);
  server.handle(publishConfirmRpc, publishConfirmHandler);
  server.handle(publishRunRpc, publishRunRpcHandler);

  server.handle(sessionSendRpc, sessionSendHandler);
  server.handle(sessionLedgerRpc, sessionLedgerHandler);
  server.handle(sessionHandoffRpc, sessionHandoffHandler);
  server.handle(sessionHandoffsListRpc, sessionHandoffsListHandler);
  server.handle(sessionHandoffReadRpc, sessionHandoffReadHandler);

  server.handle(orchestrationStateRpc, orchestrationStateHandler);
  server.handle(orchestrationSaveRpc, orchestrationSaveHandler);
  server.handle(orchestrationSiteRpc, orchestrationSiteHandler);
  server.handle(orchestrationProviderRpc, orchestrationProviderHandler);
  server.handle(orchestrationProviderInstallRpc, orchestrationProviderInstallHandler);
  server.handle(orchestrationProviderDiagnosticRpc, orchestrationProviderDiagnosticHandler);
  server.handle(orchestrationProviderRevealRpc, orchestrationProviderRevealHandler);
  server.handle(orchestrationProviderModelsRpc, orchestrationProviderModelsHandler);
  server.handle(orchestrationProfileRpc, orchestrationProfileHandler);
  server.handle(orchestrationDispatchRpc, orchestrationDispatchHandler);

  server.handle(issueAttachmentSearchRpc, searchIssueAttachmentsHandler);
  server.handle(workspaceBindingRpc, workspaceBindingHandler);
}
