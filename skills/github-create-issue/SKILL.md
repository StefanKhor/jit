---
name: github-create-issue
description: Create a new issue in a GitHub repository
when_to_use: When the user wants to file a bug, feature request, or task in GitHub
categories: [project-management, issue-tracking]
aliases: [open an issue, file a bug on GitHub, create a PR issue, report a GitHub bug]
---
# GitHub: Create Issue

## Required params
- owner, repo, title

## Optional params
- body, labels, assignees, milestone

## Steps
1. Call `github_create_issue` with owner, repo, title
2. Add body with description and reproduction steps
3. Apply labels if mentioned
4. Assign to user if specified
5. Return issue URL

## Example
User: "Open a GitHub issue in myrepo for the login bug"
→ github_create_issue(owner="me", repo="myrepo", title="Login bug", body="...", labels=["bug"])