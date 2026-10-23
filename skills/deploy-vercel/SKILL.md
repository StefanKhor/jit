---
name: deploy-vercel
description: Deploy an application to Vercel
when_to_use: When the user wants to deploy, publish, or ship an app to Vercel
categories: [deployment, devops]
---
# Deploy to Vercel

## Required params
- project path

## Optional params
- environment (production/preview), domain

## Steps
1. Check if Vercel CLI is installed (`vercel --version`)
2. Run `vercel` in the project directory
3. If first deploy, link to Vercel project
4. Set environment variables if needed
5. Return deployment URL

## Example
User: "Deploy this app to Vercel"
→ cd project → vercel → return URL