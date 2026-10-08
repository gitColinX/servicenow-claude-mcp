# Claude + ServiceNow at an IT service desk

What I built, what broke, and what it produced when I connected Claude to a
production ServiceNow instance for an enterprise IT service desk in September
2026. Nobody at the company had connected an AI tool to the instance before,
and I did not have a platform team behind me. I had the ServiceNow SDK, a dev
clone, Claude Code, and a rule that nothing touches production without a
rehearsal and a read-back.

This repo is the sanitized record: the narrative, the two core helper scripts
as they actually ran, the guardrails, the numbers, and the runbook for the
second integration path (ServiceNow's native MCP Server connected to
claude.ai). Company name, instance names, people and ticket numbers are
removed. Everything else is as it happened.

```
Phase 1  Claude Code  --ServiceNow SDK (now-sdk, OAuth per user)-->  Table API    [built, used daily]
Phase 2  claude.ai    --MCP connector (OAuth, JWT, useraccount)--->  MCP Server   [designed, runbook written]
```

| | |
|---|---|
| **Phase 1 code** | [`tools/snow-table-query.js`](tools/snow-table-query.js) (read-only) and [`tools/snow-table-write.js`](tools/snow-table-write.js) (guarded writes) |
| **Phase 2 runbook** | [`docs/mcp-connector-guide.md`](docs/mcp-connector-guide.md) |
| **Stack** | ServiceNow Zurich, `@servicenow/sdk` 4.11, Node 24, Claude Code on Windows 11, PowerShell 7 |

## The problem

A service desk runs on ServiceNow, but the evidence for whether a ticket was
actually done right lives in four other places: Entra ID, Exchange Online,
on-prem Active Directory, and Intune. Checking one offboarding by hand meant
twenty browser tabs. Checking thirty of them never happened. The asset table
had not been reconciled against the endpoint-management inventory in years.
And the change-management conflict flag fired on every single change, so
everyone had learned to ignore it.

I had been using Claude Code for scripting. The question was whether it could
reach ServiceNow safely enough to do this work for real, under my own login,
with every action attributable to me, and without a single credential typed
into a chat window.

## Phase 1: ServiceNow SDK with per-user OAuth

### How it works

The ServiceNow SDK (`now-sdk`) stores an OAuth credential per instance alias
in Windows Credential Manager, scoped to the Windows user who ran the login.
Small Node scripts pick that credential up through the SDK's own
`credentialProvider` and call the Table API. Claude Code runs the scripts.
No token is ever printed, pasted or stored in a file.

```powershell
npm install @servicenow/sdk-cli @servicenow/sdk-api
npx now-sdk auth --add https://<dev-instance>.service-now.com  --type oauth --alias dev
npx now-sdk auth --add https://<prod-instance>.service-now.com --type oauth --alias prod
npx now-sdk auth --list
```

```powershell
# read anything, write nothing
node tools\snow-table-query.js change_request --auth prod --query "active=true^state=-3" --fields number,short_description,start_date

# one record, explicit target, display values echoed back for verification
node tools\snow-table-write.js patch sc_task <sys_id> --auth prod --data '{"work_notes":"..."}'
```

### Guardrails, in the order I added them

Each one exists because of a specific moment where I realized the default
would eventually hurt someone.

1. **Two tools, not one.** The query tool is GET-only; there is no code path
   that writes. The write tool handles one record per call and echoes display
   values alongside raw values, so the output is the verification.
2. **`--auth` is required on every call, with no default alias.** The SDK
   happily falls back to a default credential. That is how a "quick check"
   becomes an accidental prod write. Removing the fallback made every call
   name its target.
3. **Dev first for anything bulk, novel, or hard to reverse.** The dev
   instance was a two-month-old clone of prod: same structure, stale data.
   Good enough to rehearse shape and volume.
4. **Dry run before apply.** The larger scripts (asset reconciliation,
   offboarding audit) default to a report. Applying needs an explicit flag,
   and a prod apply needs a second explicit confirmation flag.
5. **Guarded delete.** Deletes are limited to an allow-list of link tables
   (role assignments, group memberships, knowledge access rows), never
   business records. The sys_id must be repeated in `--confirm`. The record is
   read and snapshotted to a local JSONL log before the DELETE, so it can be
   re-POSTed. A read-after-delete must return 404 or the exit code is 1. A
   bypass flag for full deletes exists for dev and is silently ignored on any
   prod alias.
6. **Read back after every write.** Claude saying "done" is a claim. The
   record is the evidence. Every write tool re-reads the record and prints
   it.
7. **Never type a password into Claude.** The OAuth browser flow is the only
   place it belongs. The SDK's basic-auth mode is never used.

### What broke, and what I learned

- **Basic auth failed immediately.** The company logged into ServiceNow
  through Entra ID SSO, so there was no ServiceNow password to type. Fix:
  `--type oauth`, always.
- **The prod OAuth callback landed on an error page.** "Security constraints
  prevent access to requested page." Dev showed the one-time code normally;
  prod blocked the page. The code was still in the address bar. Copy the
  `code=` value, paste it into the terminal, done. Not a permissions problem,
  just a quirk worth writing down because it looks like a hard failure.
- **Credentials vanished when I ran the login elevated.** Windows Credential
  Manager is per user. An elevated shell stored the credential under the admin
  account, where Claude Code, running as my everyday account, could not see
  it. Fix: never log in from an elevated shell. Output files landed in the
  wrong profile's Downloads for the same reason, so the tools now anchor
  everything under a dated workbench folder in the repo.
- **`sys_journal_field` returned zero rows and no error.** Work notes and
  comments were simply invisible through the SDK account. Fix: read the
  concatenated `work_notes` and `comments` fields from the task record and
  split on the journal header pattern. Cost me an evening and an audit whose
  first pass showed zero documentation for a technician who had written
  plenty, because his notes were in Additional Comments rather than Work
  Notes.
- **You only see what your roles see.** ACLs hid several tables from an
  itil-level account with no error, just empty results. The SDK is not a
  bypass. Had to confirm visibility per table before trusting an empty
  answer.
- **Granting myself the SDK roles was itself a finding.** I added
  `oauth_admin`, `rest_api_explorer` and the SDK admin roles to my own prod
  account, and nothing alerted anyone. Role-grant alerting was not routed. I
  flagged it, documented it in the offboarding playbook, and later recommended
  removing the redundant self-granted roles.
- **UTC bit me twice.** Requested-date fields are stored UTC and displayed
  local. An output folder got the wrong date because the stamp used UTC. All
  day-level math now uses display values consistently.
- **A security alert fired on my own tooling.** The MSSP's EDR flagged
  `cmdkey /list` spawned from PowerShell as credential reconnaissance. Traced
  it: a different AI coding tool, not Claude Code, was enumerating stored
  credentials. Worth knowing that AI agents on an endpoint look like attackers
  to a SIEM until you explain them.
- **Token refresh just worked.** "Access Token has expired, refreshing token"
  in a log, and the query continued. One less thing.

### What it produced

| Job | Date | Result |
|---|---|---|
| **Endpoint-inventory to asset reconciliation** | 2026-09-12 | 860 managed-device serials compared against 1,078 asset records. Two dry runs, then one applied run to prod: 52 hardware records created and verified (7 of them also retiring a stale import row), 8 serials corrected, 3 assets un-retired, 37 state fixes. 34 potential creates and 18 state fixes were deliberately left as decision rows for a human, because the script could not tell a BYOD device from a missing record. First reconciliation in years. |
| **Offboarding audit, 30 days, whole team** | 2026-09-15 | 24 requests, 48 tasks and 7 orphan tasks pulled from prod in about one minute. Merged with Entra, Exchange and AD evidence (collected by separate read-only PowerShell, two device-code sign-ins, one mailbox-fleet walk across about 1,300 mailboxes) into a severity-weighted scorecard per user and per technician. Found one former employee still enabled and licensed two weeks after exit, a team-wide habit of skipping the AD password reset, and a directory job that was silently overwriting the audit stamp the playbook relied on. |
| **Change management hygiene** | 2026-09-15 | 20 active changes analysed. The conflict flag was 100 percent noise because a global maintenance window had expired. Underneath it: 8 real blackout conflicts. Five floating US holidays were pinned to 2012 dates. The CAB definition had never generated a meeting. Built a CAB-prep report and a 60-minute setup kit so the change manager could run it herself. |
| **Role and access audits** | 2026-09-19 to 09-21 | Team role-comparison workbook, approval-automation recon (about 35,000 approval records, 3,000 in the trailing 90 days), and a role request to build scoped apps with Fluent from source control. |
| **Daily use** | ongoing | Own-queue triage, person timelines across tickets, text search across journals, hardware-recovery emails generated from live task data, attachments posted to tasks. Fourteen helper scripts in all. |

Only the two generic tools are in this repo. The other twelve are built on the
same two primitives but are shaped around one company's catalog items,
variables and playbook, so they do not sanitize cleanly.

## Phase 2: ServiceNow's native MCP Server and claude.ai

The SDK path works in Claude Code, on a machine, for someone comfortable with
a terminal. Analysts work tickets in a chat window. The way to reach them is
ServiceNow's own MCP Server app, exposed as a connector in claude.ai, with
OAuth delegated per user so every tool call is audited under the analyst's own
login.

I verified the prerequisites on the instance (the MCP Server app, its health
endpoint, the Quickstart server, the Application Registry state), worked out
the exact OAuth record settings from ServiceNow's reference material and a
test, and wrote the runbook in [`docs/mcp-connector-guide.md`](docs/mcp-connector-guide.md).
It covers:

- The three values the Claude connector form needs and where each one comes
  from in ServiceNow.
- The settings that must be exact, and the symptom when each one is wrong.
  Token Format left on the Opaque default connects cleanly and then exposes
  zero tools, which is the kind of failure that costs an afternoon.
- Proving the pipe with the read-only Quickstart server before building a
  tool set.
- A minimum tool set for a service desk (get and update incident, get and
  update catalog task) and the roles needed to create it.
- A hardening checklist: vault the secret, tell the platform owner, replace
  the broad `useraccount` scope with a custom scope once the tool set
  settles, treat ticket text reaching the model as untrusted.

Production rollout was gated on two things outside my control: confirming the
Now Assist licensing that the MCP Server app ships under, and a governance
decision about company ticket data reaching a third-party AI tenant. Both were
raised with the right people before anything was connected.

## Lessons that transfer

1. **Per-user OAuth beats a service account every time.** The audit trail
   stays honest, access follows the person's real roles, and offboarding the
   person offboards the integration.
2. **Make the agent name its target.** No default alias, no default instance,
   no implicit prod. The one time this feels annoying is the one time it
   matters.
3. **Separate read from write at the tool level, not the prompt level.** A
   prompt can be talked out of a rule. A script with no write path cannot.
4. **Rehearse on a clone, dry-run on prod, then apply with a read-back.**
   Three gates, each cheap, each catching a different class of mistake.
5. **Leave decisions to humans and say so in the output.** The asset script
   created 52 records and refused 34. The refusals, each with a reason, were
   the most useful part of the report.
6. **Treat imported ticket text as data, not instructions.** Ticket
   descriptions, work notes and attachments reach the model. None of it gets
   to steer the model.
7. **Expect to look like an attacker.** Credential-manager reads, API bursts
   and new OAuth clients all trip detections. Tell the security team first.
8. **Write the quirks down the day you hit them.** The prod callback error
   page, the elevated-shell credential trap and the invisible journal table
   each looked like a dead end. Each has a one-line fix. A second person set
   up the same toolchain from my notes in about an hour.

## About

Colin Lundholm. Systems administrator and endpoint, identity and cloud
engineer in Denver. [GitHub profile](https://github.com/gitColinX) ·
[LinkedIn](https://www.linkedin.com/in/cdlundholm). Corrections welcome by
issue or pull request. MIT licensed.
