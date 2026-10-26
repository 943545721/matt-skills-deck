MattSkillsDeck brings the Matt Pocock engineering skill set and an issue board into Paseo.

It bundles 27 skills for planning, triage, implementation, review and handoff, in English and Chinese. It also reads your project's issues from GitHub, GitLab or local Markdown files and shows them in a workspace panel next to the agent, grouped by what you can start, what is in progress, and what is closed.

Open a workspace and pick 任务板 from the tab bar. The panel reads issues through the `gh` or `glab` command line tool, so the daemon machine needs one of them installed and signed in for the matching backend. Without either, the panel reports what is missing instead of showing empty lists.

Skills are installed per workspace from the panel's skills page. Nothing is written into a repository until you press install, and the panel lists the files it will create first. A newly installed skill becomes visible to an agent when that agent's session starts or restarts.

The panel is read only in this version. Writing labels, comments and new issues arrives in a later release. The plugin runs on the daemon with the daemon user's permissions, the same as any other plugin, and never sends your issue data anywhere except to the backend you selected.
