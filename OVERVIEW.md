MattSkillsDeck brings Matt Pocock's engineering skill set and an issue board into Paseo.

It bundles 27 skills for planning, triage, implementation, review and handoff, each in English and Chinese, and adds a workspace panel for the issues of the repository that workspace points at. The board lists issues with their labels and assignees, opens one issue with its body and comments, and can comment on it, create a new issue, or replace an issue's labels. Issues labelled `wayfinder:map` open a map page that reads the map body's five sections, lists the tickets on the map's route, and suggests three next steps you can copy as a prompt.

Skills are copied into a workspace from the panel's skills page. Nothing is written into the repository until you press install, and the page lists the files it will create before it does.

New agent sessions started in a workspace whose remote is on github.com get seven `deck_*` tools through a small MCP server the plugin starts for them. Listing issues, reading one issue, reading a map and reading next steps are preapproved; commenting, creating an issue and replacing labels ask for approval first. Workspaces without a GitHub remote get no tools.

Reading and writing go through the `gh` command line tool using the daemon user's existing login, so the plugin never stores a token and issue data goes only to GitHub. The daemon machine needs `gh` installed and signed in, and the plugin requires Paseo 0.13.

The panel follows the app's language, in Chinese or English. The plugin runs on the daemon with the daemon user's permissions, like any other plugin, and runs `git` and `gh` only inside the workspace it belongs to.
