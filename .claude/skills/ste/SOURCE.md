# 来源

- 上游：https://github.com/dualface/ste-zh
- 提交：27d57e4d6609
- 许可：MIT（见同目录 LICENSE）
- 安装日期：2026-10-30

## 本仓库做过的改动

只改了一处：`SKILL.md` 的 frontmatter 原来是 YAML 折叠块（`description: >`），
本插件 `server/skills/frontmatter.ts` 只认单行 `key: value`，折叠块会被读成 `>`，
技能页显示不出描述。已压成单行，文案一字未改。其余文件与上游逐字一致。

## 边界

- 只管 Agent 对用户的汇报文字；不管代码、注释、commit message、写进项目的文件
- 不是 ASD 官方中文标准，不提供合规认证，不随附官方词典

## 语言两侧

`zh/SKILL.md` 与 `zh/references/terminology.md` 是正文。`en` 侧由 Claude 于 2026-10-30 逐条译出，内容对应 zh 侧；`examples/` 保持中文，因为这份技能管的就是中文汇报。
