MattSkillsDeck brings Matt Pocock's engineering skill set and an issue board into Paseo.

It bundles 27 skills for planning, triage, implementation, review and handoff, each in English and Chinese, and adds a workspace panel for the issues of the repository that workspace points at. The board shows ready / blocked / closed counts, filters and sorting, freshness and rate-limit readings, and pull requests on their own tab. It opens one issue with its body, comments and blockers, and can comment, create an issue or a requirement, replace labels, take an issue or close it. Issues labelled `wayfinder:map` open a map page that reads the map body's five sections, groups tickets into ready / claimed / blocked / closed, layers them by blocking edges with per-layer progress, and suggests next steps you can copy as a prompt.

Skills are copied into a workspace from the panel's skills page. Nothing is written into the repository until you press install, and the page lists the files it will create before it does.

New agent sessions get fourteen `deck_*` tools through a small MCP server the plugin starts for them. Listing issues, reading one issue, reading a map, reading next steps, listing pull requests and probing the environment are preapproved; commenting, creating, patching, relabelling and creating map plans ask for approval first. GitHub and GitLab remotes always get tools; the local backend gets them once the workspace has a `.deck/` board (or the settings say `local`).

The backend is chosen in the plugin settings: GitHub via `gh`, GitLab via `glab` (read-only), or a local Markdown board under `.deck/`. The plugin never stores a token; GitHub and GitLab data goes only to those remotes. The daemon machine needs the chosen CLI installed and signed in; the local backend needs none. The plugin requires Paseo 0.13.

The panel follows the app's language, in Chinese or English. The plugin runs on the daemon with the daemon user's permissions, like any other plugin, and runs `git`, `gh` and `glab` only inside the workspace it belongs to.
