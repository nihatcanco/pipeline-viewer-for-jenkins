# Security Policy

## Reporting a vulnerability

Please do not report security problems in public issues. Instead, use GitHub's private vulnerability reporting:
go to the [Security tab](https://github.com/nihatcanco/pipeline-viewer-for-jenkins/security/advisories/new) of this
repository and choose **Report a vulnerability**.

Please include the extension version, your VS Code version, the steps to reproduce the problem and what an attacker
could achieve with it. I will acknowledge the report, keep you updated while it is investigated, and credit you in
the release notes if you wish.

## Supported versions

Security fixes are released for the latest version only.

## What counts as a vulnerability

The extension holds a Jenkins API token, so the most important guarantees are:

- The token is only ever sent to the Jenkins server it was entered for.
- The extension makes no network requests to any host other than the configured Jenkins server.
- Opening a workspace or repository cannot change which server the extension talks to, or make it act on Jenkins
  without the user's action.
- The MCP server for AI agents only answers programs on the same computer that present its access token, and an
  agent cannot start or abort a build without the user's approval in VS Code.

Anything that breaks one of these is in scope, as is any way to run code or read files through content that a Jenkins
server returns.
