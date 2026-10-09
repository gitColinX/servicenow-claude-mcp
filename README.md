# ServiceNow Claude MCP

Helper scripts for working in ServiceNow from Claude Code, and a runbook for ServiceNow's MCP connector.

In September 2026 I connected Claude Code to our production ServiceNow instance at work. Checking one offboarding by hand meant twenty browser tabs, and the asset table had not been reconciled in years. Claude used my own OAuth sign-in through the ServiceNow SDK, so every call ran under my account and I never typed a password into Claude. Bulk writes got a dry run first, and every write was read back.

## What's in here

- [tools/](tools/) - a rewrite of the two helpers I ran daily: a read-only query tool, and a write tool that changes one record per call and checks it afterwards against what it sent.
- [docs/mcp-connector-guide.md](docs/mcp-connector-guide.md) - my runbook for connecting claude.ai to ServiceNow's own MCP Server with per-user OAuth. It didn't go live. Rollout was waiting on a licensing check and a governance decision.
- [test/](test/) - tests for the guards in both tools.

## What it did at work

- Reconciled 860 managed-device serials against 1,078 asset records. After two dry runs, one run on prod created 52 hardware records, corrected 8 serials and fixed 37 asset states. I left 34 rows for a person to review, each with a reason.
- Ran a read-only audit of the last 30 days of offboarding for the service desk manager. I pulled 24 requests and 48 tasks from prod in about a minute and checked each account against Entra, Exchange and AD to see whether it reached the end state in our playbook, which the tickets alone could not show.
- Reviewed 20 active changes for CAB and separated conflict-checker noise from the schedule conflicts worth discussing.
- Day to day: my own queue triage, a requester's full ticket history, text search across work notes and comments, and hardware-recovery emails built from live task data. Fourteen helper scripts in all.

## Try it

```powershell
npm test
```

Runs 20 offline tests of the guards (production confirmation, read-back, guarded deletes) against a stubbed SDK. All passed on 2026-10-09. I wrote this version with Claude Code and have not run it against a live instance.

## More detail

- [Full write-up](docs/WRITEUP.md) - how the SDK sign-in works, the guardrails, problems I hit, full results and lessons.

## About

Colin Lundholm, IT Support Engineer · [GitHub profile](https://github.com/gitColinX) · [LinkedIn](https://www.linkedin.com/in/cdlundholm)

[MIT licensed](LICENSE).
