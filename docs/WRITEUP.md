# How I connected Claude Code to ServiceNow

In September 2026 I connected Claude Code to a production ServiceNow instance
for an enterprise IT service desk. The instance had no AI integration
registered yet, and I worked without a dedicated ServiceNow platform team. I
had the ServiceNow SDK, a dev clone and Claude Code. My rule was that nothing
touched production without a rehearsal and a read-back.

I removed the company name, instance names, people and ticket numbers.

The work had two phases. The first, which I built and used daily, ran small
Node scripts from Claude Code against the ServiceNow Table API through the
SDK, signed in as me. The second, which I designed and wrote a runbook for but
did not roll out, connects claude.ai to ServiceNow's own MCP Server. A rewrite
of the two core scripts is in [tools/](../tools/) and the runbook is
[mcp-connector-guide.md](mcp-connector-guide.md).

Stack: ServiceNow Zurich, `@servicenow/sdk` 4.11.2, Node 24, Claude Code on
Windows 11, PowerShell 7.

## The problem

A service desk runs on ServiceNow, but the evidence for whether a ticket was
actually done right lives in four other places: Entra ID, Exchange Online,
on-prem Active Directory, and Intune. Checking one offboarding by hand meant
twenty browser tabs. Checking thirty of them by hand was not realistic. The
asset table had not been reconciled against the endpoint-management inventory
in years. And change review needed a clear list of the conflicts that
actually mattered.

I had been using Claude Code for scripting and wanted to see if it could do
this work against ServiceNow safely, under my own login, without me typing a
credential into a chat.

## Phase 1: ServiceNow SDK with per-user OAuth

### How it works

The ServiceNow SDK (`now-sdk`) keeps an OAuth access and refresh token per
instance alias in Windows Credential Manager, DPAPI-protected under the Windows
user who ran the login. Small Node scripts pick that credential up through the
SDK's own `credentialProvider` and call the Table API. Claude Code, on the
company's Claude Enterprise seat, runs the scripts. The scripts never print a
token or write one to a plaintext file, and no credential is ever pasted into
a chat.

```powershell
npm install    # @servicenow/sdk 4.11.2 from package.json, which provides now-sdk
npx now-sdk auth --add https://<dev-instance>.service-now.com  --type oauth --alias dev
npx now-sdk auth --add https://<prod-instance>.service-now.com --type oauth --alias prod
npx now-sdk auth --list
```

```powershell
# read anything, write nothing
node tools\snow-table-query.js change_request --auth prod --query "active=true^state=-3" --fields number,short_description,start_date

# one record, explicit target, read back and compared field by field
node tools\snow-table-write.js patch sc_task <sys_id> --auth prod --confirm-prod --data '{"work_notes":"..."}'
```

PowerShell 7.3 or later passes the JSON as written. Windows PowerShell 5.1
strips the inner quotes, so use `--data-file payload.json` there (and
`npx.cmd` if script execution is restricted).

### Guardrails

I added these in this order.

1. I kept read and write in separate tools. The query tool only reads, and
   there is no code path in it that writes. The write tool changes one record
   per call and prints display values next to raw values, so I could check
   the result from the output.
2. Every call needs `--auth`, and there is no default alias. The SDK falls
   back to a default credential if you let it, so a quick check could end up
   writing to prod. Removing the fallback made every call name its target.
3. Anything bulk, new or hard to reverse ran on dev first. The dev instance
   was a two-month-old clone of prod, with the same structure and stale data,
   which was good enough to rehearse shape and volume.
4. Bulk writes got a dry run first. The bulk-write scripts (asset
   reconciliation, asset sweep, location merge) default to a report. Applying
   needs an explicit flag, and applying on prod needs a second confirmation
   flag. The audit scripts, the offboarding audit included, are read-only end
   to end. The flags stop accidental runs. I still approved production writes
   before they ran. In later sessions, routine reads often ran under Claude
   Code's auto mode, where a classifier approves them, but my standing
   instructions to the agent still required my approval for production
   writes.
5. Deletes are guarded. They are limited to an allow-list of link tables
   (role assignments, group memberships, knowledge access rows), never
   business records. The sys_id has to be repeated in `--confirm`. The record
   is read and saved to a local JSONL log before the DELETE, so it can be
   restored. A read after the delete must return 404, or the exit code is 1.
   A bypass flag for full deletes exists for dev, and prod refuses it with an
   error.
6. Every write is read back. I checked the record instead of trusting
   Claude's "done". The bulk scripts re-read every record they changed and
   marked each row verified or not. At work, the single-record write tool
   printed the record as ServiceNow returned it, raw and display values
   together, and I compared that with what I had sent. The rewrite in this
   repo does that comparison automatically.
7. I never type a password into Claude. Sign-in only happens in the OAuth
   browser flow, not the SDK's basic-auth mode.

### Problems I hit

- Basic auth failed immediately. My first command on day one was
  `now-sdk auth --add <prod> --type basic`. The company logged into ServiceNow
  through Entra ID SSO, so there was no ServiceNow password to type. Fix:
  `--type oauth`, always.
- The prod OAuth callback landed on an error page: "Security constraints
  prevent access to requested page." Sign-in and consent had already
  succeeded. Only the page that displays the one-time code was blocked, where
  dev showed it normally. The code was still in the address bar, and the SDK
  login asks you to paste that code into the terminal by design, so I copied
  the `code=` value and pasted it. It doesn't bypass anything. It just looks
  like a failure when it isn't.
- Running the login elevated saved the credential to the wrong account. On
  that laptop, elevating meant running as my separate admin account, and
  Windows Credential Manager is per user. The credential landed in the admin
  account's vault, where Claude Code, running as my everyday account, could
  not see it. Fix: run the login from a normal shell as the everyday account.
  Output files landed in the wrong profile's Downloads for the same reason, so
  the tools now anchor everything under a dated workbench folder in the repo.
- `sys_journal_field` returned zero rows and no error. Work notes and
  comments were simply invisible through the SDK account. Fix: read the
  concatenated `work_notes` and `comments` fields from the task record and
  split on the journal header pattern. Cost me an evening, and a first audit
  pass that showed zero documentation on some of my own offboarding tickets,
  because I had posted my notes as Additional Comments rather than Work Notes.
- You only see what your roles see. ACLs hid several tables from an
  itil-level account with no error, just empty results. I had to confirm
  visibility per table before trusting an empty answer.
- The SDK roles deserve the same scrutiny as any admin role. The SDK path
  needs `oauth_admin`, `rest_api_explorer` and the SDK admin roles. Treat them
  like any admin grant: time-box them, list them with the other
  high-privilege roles your offboarding checks, and make sure someone is told
  when one is granted.
- UTC bit me twice. Requested-date fields are stored UTC and displayed
  local. An output folder got the wrong date because the stamp used UTC. All
  day-level math now uses display values consistently.
- Token refresh just worked. "Access Token has expired, refreshing token"
  showed up in a log, and the query continued. (The SDK prints that line on
  stdout, which is why the rewrite here sends SDK logging to stderr.)

### Results

- 2026-09-11, asset reconciliation: compared 860 managed-device serials
  against 1,078 asset records. After two dry runs, one run on prod created and
  verified 52 hardware records (7 also retired a stale import row), corrected
  8 serials, un-retired 3 assets and made 37 state fixes. I left 34 rows (13
  personal devices, 13 stale inventory records and 8 judgment calls) and 18
  flagged state fixes for a person, each with a reason. It was the first
  reconciliation in years.
- 2026-09-15, offboarding audit for the last 30 days: run at the service desk
  manager's request, read-only end to end. I pulled 24 requests, 48 tasks and
  7 orphan tasks from prod in about a minute, then merged them with Entra,
  Exchange and AD evidence collected by separate read-only PowerShell (two
  device-code sign-ins and one walk across 1,278 mailboxes). The result was a
  compliance report per offboarding, weighted by severity and checked against
  the end state the playbook expects. It showed what the tickets alone could
  not: whether each account had actually reached that end state.
- 2026-09-15, CAB prep: analyzed 20 active changes, read-only. I built a
  report that separates conflict-checker noise from the schedule conflicts
  worth discussing, and a starter kit with a one-hour getting-started guide.
- 2026-09-19 to 09-21, role and access audits: a team role-comparison
  workbook, a look at approval automation (about 35,000 approval records,
  about 3,100 of them in the last 90 days), and a role request to build scoped
  apps with Fluent from source control.
- Ongoing, daily use: my own queue triage, a requester's full history across
  tickets, text search across work notes and comments, hardware-recovery
  emails built from live task data, and attachments posted to tasks. Fourteen
  helper scripts in all.

Only rewrites of the two generic tools are in this repo. The other twelve are
built on the same two tools but are shaped around one company's catalog
items, variables and playbook, so they do not sanitize cleanly.

### About the code

The two scripts in `tools/` are a fresh rewrite, made for this repo, of the
two generic helpers I ran at work. At work, Claude Code wrote most of the
helper code to my spec. I set the guardrails and ran those versions daily.
The rewrite hardens them further:

- Read-back is automatic. After every post or patch the write tool GETs the
  record again and compares each field it sent with what the record now
  holds. The Table API answers 200 and silently ignores a misspelled field or
  one a write ACL blocks, so a write that did not land now ends in
  `ok: false`, a list of mismatches and exit code 1. Work notes and comments
  are journals, so for those the check is that the new entry appears.
- Production fails closed. Only aliases listed as non-production in
  [`tools/lib/snow.js`](../tools/lib/snow.js), optionally pinned to a host,
  count as non-production. `prod`, `PROD`, `production` and any alias I forget
  to list are all production, and every write to production needs
  `--confirm-prod`. The tools refuse to run when `SN_SDK_*` session variables
  are set, because those make the SDK ignore `--auth`.
- Inputs cannot steer the URL. Table names and sys_ids are validated before
  they go into the request path.
- stdout is one JSON document. SDK log lines go to stderr, and an HTML error
  page comes back with its HTTP status instead of a parse error.
- Deletes log their outcome. The snapshot holds raw values, so a POST can
  restore it, and a second log line records the DELETE status and whether
  the record is gone.

`npm test` runs offline tests of these guards against a stubbed SDK. See
[How this was built](#how-this-was-built) for the current count.

### Using Codex alongside Claude Code

Claude Code on the company's Claude Enterprise seat was my primary tool. When
I hit its usage limits, I pointed Codex, signed in to the company's ChatGPT
workspace, at the same folders. I used Codex from mid-August (the desktop app,
for OCR) and the Codex CLI from 2026-08-21. The swap was painless because
earlier in August I had replaced a Claude-only CLAUDE.md with an agent-neutral
AGENTS.md: search order, source precedence, safety rules for operational
commands, and a completion standard that apply to any agent. Each tool gets a
thin shim that points back to it.

The Codex shim, CODEX.md, restates two verification rules from AGENTS.md. I
wrote them after a Codex session reported ServiceNow checks it had not
actually run:

- Never write "verified" or "confirmed" in a ticket note unless the literal
  read-back output that backs it appears in the same turn.
- Never close a ticket in the same step as the change. Read the changed
  record back, close it as a separate step, and quote the read-back in the
  close note.

The builder script for the team role-comparison workbook in the results above
was Codex-generated. The same rules applied to it.

## Phase 2: ServiceNow's native MCP Server and claude.ai

The SDK path works in Claude Code, on a machine, for someone comfortable with
a terminal. Analysts work tickets in a chat window. The way to reach them is
ServiceNow's own MCP Server app, exposed as a connector in claude.ai, with
OAuth delegated per user so every tool call is audited under the analyst's own
login. I was already using the Microsoft 365 connector for mailbox and Teams
search on tickets, so MCP was not new to me.

I checked the instance's Application Registry (no existing Claude or MCP
record), worked out the exact OAuth record settings from ServiceNow's
reference material, and wrote the runbook in
[`docs/mcp-connector-guide.md`](mcp-connector-guide.md), with the
prerequisite checks (the MCP Server app, its health endpoint, the Quickstart
server) as its Step 0. It covers:

- The three values the Claude connector form needs and where each one comes
  from in ServiceNow.
- The settings that must be exact, and the symptom when each one is wrong.
  Token Format left on the Opaque default connects cleanly and then exposes
  zero tools.
- Proving the pipe with the read-only Quickstart server before building a
  tool set.
- A minimum tool set for a service desk (get and update incident, get and
  update catalog task) and the roles needed to create it.
- A hardening checklist: vault the secret, tell the platform owner, replace
  the broad `useraccount` scope with a custom scope once the tool set
  settles, treat ticket text reaching the model as untrusted.

Production rollout was gated on two things outside my control: confirming the
Now Assist licensing that the MCP Server app ships under, and a governance
decision on opening ticket tools to every analyst's claude.ai chat. The
connector stayed at the runbook stage.

## Lessons

1. Use per-user OAuth instead of a service account. The audit trail stays
   honest, access follows the person's real roles, and offboarding the
   person offboards the integration.
2. Make the agent name its target. No default alias, no default instance, no
   implicit prod.
3. Separate read and write in the tools themselves. A prompt can be talked
   out of a rule. A read-only script cannot write, and anything else the
   agent wants to run still goes through the permission rules I set.
4. Rehearse on a clone, dry-run on prod, then apply with a read-back.
5. Leave decisions to people and say so in the output. The asset script
   created 52 records and left 34 candidates and 18 state fixes for a person
   to decide. The reasons on those rows were the most useful part of the
   report.
6. Treat ticket text as untrusted. Ticket descriptions, work notes and
   attachments reach the model. The instruction files say none of it is an
   instruction, and writes only go through tools and permission rules I set.
   That does not make prompt injection impossible. It limits what an injected
   instruction could do.
7. Tell the security team first. Credential-manager reads, API bursts and new
   OAuth clients all trip detections.
8. Write the quirks down the day you hit them. The prod callback error page,
   the elevated-shell credential trap and the invisible journal table each
   looked like a dead end. Each has a one-line fix. Those notes became a
   starter kit with a one-hour getting-started guide.

## How this was built

This is a fresh rewrite, generalized from what I ran at work, written with
Claude Code. I directed the work and checked the results against my own
records. The code here is tested offline against synthetic fixtures (20 tests
passing on 2026-10-09) and has not been run against a live ServiceNow
instance in this form.

## About

Colin Lundholm, IT Support Engineer · [GitHub profile](https://github.com/gitColinX) ·
[LinkedIn](https://www.linkedin.com/in/cdlundholm)

Corrections welcome by issue or pull request. MIT licensed.
