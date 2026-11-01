# Changelog

## 0.3.0

- AI agents such as Claude Code can use Jenkins through a local MCP server. They can list jobs and read builds, stages and console logs, and start or abort builds after you approve them in VS Code. It is off by default; turn it on from the settings page or with **Jenkins: Set Up AI Agent Access (MCP)**.

## 0.2.0

- Jobs show when their last completed build finished.
- A settings page for the connection, refresh interval, build history and notifications, opened from the gear in the Pipelines view.

## 0.1.0

First public release.

- Pipelines view with folders, multibranch projects, jobs, recent builds and pipeline stages.
- Status bar summary of failing and running jobs.
- Notifications for finished builds.
- Console logs in an editor tab, with reload for running builds.
- Build Now, Abort Build and Open in Browser actions.
- Build Now on a parameterized job lets you review and change its parameters before the build starts.
- Clear guidance when the Jenkins server's certificate is not trusted, such as a self-signed certificate.
