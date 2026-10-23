---
name: linear-create-issue
description: Create a new issue in a Linear team
when_to_use: When the user wants to file a bug, task, or feature request in Linear
categories: [project-management, issue-tracking]
aliases: [file a bug, open a ticket, report an issue, create a task, log a bug]
---
# Linear: Create Issue

## Required params
- teamId, title

## Optional params
- description, priority, labels, assignee

## Steps
1. Call `linear_create_issue` with teamId and title
2. Set priority based on user description (urgent/high/medium/low)
3. Add labels if mentioned
4. Assign to user if specified
5. Confirm creation with the user, return issue URL

## Example
User: "Create a bug in ENG team about login failing"
→ linear_create_issue(teamId="ENG", title="Login failing", priority="high", labels=["bug"])