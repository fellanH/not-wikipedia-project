# not-wikipedia-project — Repos

Child repositories and components in this workspace:

| Component          | Role                                           | Status |
| ------------------ | ---------------------------------------------- | ------ |
| local-agent/       | Autonomous article generation agent            | Active |
| wiki-content/      | Submodule — generated encyclopedia content     | Active |
| roadmap-dashboard/ | Submodule — visual roadmap and progress UI     | Active |
| roadmap-agent.sh   | Roadmap execution script                       | Active |
| roadmap-logs/      | Agent run logs                                 | Active |

## Dependencies

- wiki-content is produced by local-agent
- roadmap-dashboard reads from ROADMAP.md and roadmap-logs
