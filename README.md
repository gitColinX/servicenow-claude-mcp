# Claude + ServiceNow at an IT service desk

What I built, what broke, and what it produced when I connected Claude to a
production ServiceNow instance for an enterprise IT service desk in September
2026. The instance had no AI integration registered yet, and I worked without
a dedicated ServiceNow platform team. I had the ServiceNow SDK, a dev clone,
Claude Code, and a rule that nothing touches production without a rehearsal
and a read-back.

This repo is the sanitized record: the narrative, the guardrails, the numbers,
a fresh rewrite of the two core helper scripts, and the runbook for the second
integration path (ServiceNow's native MCP Server connected to claude.ai).
Company name, instance names, people and ticket numbers are removed. What
remains is as it happened.

```
Phase 1  Claude Code  --ServiceNow SDK (now-sdk, OAuth per user)-->  Table API    [built, used daily]
Phase 2  claude.ai    --MCP connector (OAuth, JWT, useraccount)--->  MCP Server   [designed, runbook written]
```

| | |
|---|---|
| **Phase 1 code** | [`tools/snow-table-query.js`](tools/snow-table-query.js) (read-only) and [`tools/snow-table-write.js`](tools/snow-table-write.js) (single-record writes with read-back, guarded deletes): a fresh rewrite, generalized from what I ran at work. See [About the code](#about-the-code). |
| **Phase 2 runbook** | [`docs/mcp-connector-guide.md`](docs/mcp-connector-guide.md) |
| **Stack** | ServiceNow Zurich, `@servicenow/sdk` 4.11.2, Node 24, Claude Code on Windows 11, PowerShell 7 |

## The problem

A service desk runs on ServiceNow, but the evidence for whether a ticket was
actually done right lives in four other places: Entra ID, Exchange Online,
on-prem Active Directory, and Intune. Checking one offboarding by hand meant
twenty browser tabs. Checking thirty of them by hand was not realistic. The
asset table had not been reconciled against the endpoint-management inventory
in years. And change review needed a clear list of the conflicts that
actually mattered.

I had been using Claude Code for scripting. The question was whether it could
reach ServiceNow safely enough to do this work for real, under my own login,
with every action attributable to me, and without a single credential typed
into a chat window.

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
4. **Dry run before apply.** The bulk-write scripts (asset reconciliation,
   asset sweep, location merge) default to a report. Applying needs an
   explicit flag, and a prod apply needs a second explicit confirmation flag.
   The audit scripts, the offboarding audit included, are read-only end to
   end. The flags stop an accidental run; they are not the approval. I
   approved production writes before they ran. In later sessions, routine
   reads often ran under Claude Code's auto mode, whose classifier approves
   them; the contract (my standing instructions to the agent) still required
   my approval for production writes.
5. **Guarded delete.** Deletes are limited to an allow-list of link tables
   (role assignments, group memberships, knowledge access rows), never
   business records. The sys_id must be repeated in `--confirm`. The record is
   read and snapshotted to a local JSONL log before the DELETE, so it can be
   restored. A read-after-delete must return 404 or the exit code is 1. A
   bypass flag for full deletes exists for dev and is refused, with an error,
   on prod.
6. **Read back after every write.** Claude saying "done" is a claim. The
   record is the evidence. The bulk scripts re-read every record they changed
   and marked each row verified or not. The single-record write tool printed
   the record as ServiceNow returned it, raw and display values together, and
   I compared that with what I had sent. The rewrite in this repo automates
   that comparison.
7. **Never type a password into Claude.** The OAuth browser flow is the only
   place it belongs. The SDK's basic-auth mode is never used.

### What broke, and what I learned

- **Basic auth failed immediately.** My first command on day one was
  `now-sdk auth --add <prod> --type basic`. The company logged into ServiceNow
  through Entra ID SSO, so there was no ServiceNow password to type. Fix:
  `--type oauth`, always.
- **The prod OAuth callback landed on an error page.** "Security constraints
  prevent access to requested page." Sign-in and consent had already
  succeeded; only the page that displays the one-time code was blocked, where
  dev showed it normally. The code was still in the address bar, and the SDK
  login asks you to paste that code into the terminal by design. Copy the
  `code=` value, paste it, done. Not a way around a permission, just a quirk
  worth writing down because it looks like a hard failure.
- **Credentials vanished when I ran the login elevated.** On that laptop,
  elevating meant running as my separate admin account, and Windows
  Credential Manager is per user. The credential landed in the admin
  account's vault, where Claude Code, running as my everyday account, could
  not see it. Fix: run the login from a normal shell as the everyday account.
  Output files landed in the wrong profile's Downloads for the same reason, so
  the tools now anchor everything under a dated workbench folder in the repo.
- **`sys_journal_field` returned zero rows and no error.** Work notes and
  comments were simply invisible through the SDK account. Fix: read the
  concatenated `work_notes` and `comments` fields from the task record and
  split on the journal header pattern. Cost me an evening, and a first audit
  pass that showed zero documentation on some of my own offboarding tickets,
  because I had posted my notes as Additional Comments rather than Work Notes.
- **You only see what your roles see.** ACLs hid several tables from an
  itil-level account with no error, just empty results. The SDK is not a
  bypass. Had to confirm visibility per table before trusting an empty
  answer.
- **The SDK roles deserve the same scrutiny as any admin role.** The SDK path
  needs `oauth_admin`, `rest_api_explorer` and the SDK admin roles. Treat them
  like any admin grant: time-box them, list them with the other
  high-privilege roles your offboarding checks, and make sure someone is told
  when one is granted.
- **UTC bit me twice.** Requested-date fields are stored UTC and displayed
  local. An output folder got the wrong date because the stamp used UTC. All
  day-level math now uses display values consistently.
- **Token refresh just worked.** "Access Token has expired, refreshing token"
  in a log, and the query continued. One less thing. (The SDK prints that line
  on stdout, which is why the rewrite here sends SDK logging to stderr.)

### What it produced

| Job | Date | Result |
|---|---|---|
| **Endpoint-inventory to asset reconciliation** | 2026-09-11 | 860 managed-device serials compared against 1,078 asset records. Two dry runs, then one applied run to prod: 52 hardware records created and verified (7 of them also retiring a stale import row), 8 serials corrected, 3 assets un-retired, 37 state fixes. 34 candidate rows (13 personal devices that get no asset by default, 13 stale inventory records where the asset's retirement stands, and 8 judgment calls, such as un-retiring an asset or matching a near-identical serial) and 18 flagged state fixes were deliberately left for a human, each with a reason. First reconciliation in years. |
| **Offboarding compliance audit, last 30 days** | 2026-09-15 | Run at the service desk manager's request. 24 requests, 48 tasks and 7 orphan tasks pulled from prod in about one minute. Merged with Entra, Exchange and AD evidence (collected by separate read-only PowerShell, two device-code sign-ins, one mailbox-fleet walk across 1,278 mailboxes) into a severity-weighted compliance report per offboarding, checked against the end state the playbook expects. Read-only end to end. It showed what the ticket record alone could not: whether each account had actually reached that end state. |
| **CAB preparation** | 2026-09-15 | 20 active changes analysed, read-only. Built a CAB-prep report that separates conflict-checker noise from the schedule conflicts worth discussing, and a starter kit with a one-hour getting-started guide. |
| **Role and access audits** | 2026-09-19 to 09-21 | Team role-comparison workbook, approval-automation recon (about 35,000 approval records, about 3,100 in the last 90 days), and a role request to build scoped apps with Fluent from source control. |
| **Daily use** | ongoing | Own-queue triage, a requester's full history across tickets, text search across journals, hardware-recovery emails generated from live task data, attachments posted to tasks. Fourteen helper scripts in all. |

Only rewrites of the two generic tools are in this repo. The other twelve are
built on the same two primitives but are shaped around one company's catalog
items, variables and playbook, so they do not sanitize cleanly.

### About the code

The two scripts in `tools/` are a fresh rewrite, made for this repo, of the
two generic helpers I ran at work: new code, same guardrails. At work, Claude
Code wrote most of the helper code to my spec; I set the guardrails and ran
those versions daily. The rewrite hardens them further:

- **Read-back is automatic.** After every post or patch the write tool GETs
  the record again and compares each field it sent with what the record now
  holds. The Table API answers 200 and silently ignores a misspelled field or
  one a write ACL blocks, so a write that did not land now ends in
  `ok: false`, a list of mismatches and exit code 1. Work notes and comments
  are journals, so for those the check is that the new entry appears.
- **Production fails closed.** Only aliases listed as non-production in
  [`tools/lib/snow.js`](tools/lib/snow.js), optionally pinned to a host, count
  as non-production. `prod`, `PROD`, `production` and any alias I forget to
  list are all production, and every write to production needs
  `--confirm-prod`. The tools refuse to run when `SN_SDK_*` session variables
  are set, because those make the SDK ignore `--auth`.
- **Inputs cannot steer the URL.** Table names and sys_ids are validated
  before they go into the request path.
- **stdout is one JSON document.** SDK log lines go to stderr, and an HTML
  error page comes back with its HTTP status instead of a parse error.
- **Deletes log their outcome.** The snapshot holds raw values, so a POST can
  restore it, and a second log line records the DELETE status and whether the
  record is gone.

`npm test` runs offline tests of these guards against a stubbed SDK. See
[How this was built](#how-this-was-built) for the current count.

### The Codex side

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
  read-back output that backs it appears in the same turn. A description of
  what the check would show is not the check.
- Never close a ticket in the same step as the change. Read the changed
  record back, close it as a separate step, and quote the read-back in the
  close note.

The builder script for the team role-comparison workbook in the table above
was Codex-generated. Different vendor, same rules.

## Phase 2: ServiceNow's native MCP Server and claude.ai

The SDK path works in Claude Code, on a machine, for someone comfortable with
a terminal. Analysts work tickets in a chat window. The way to reach them is
ServiceNow's own MCP Server app, exposed as a connector in claude.ai, with
OAuth delegated per user so every tool call is audited under the analyst's own
login. MCP itself was not new to me by then: I was already using the Microsoft
365 connector for mailbox and Teams search on tickets. I had also configured an
AWS MCP server in Claude Code, but it never got working credentials, so my AWS
WorkSpaces admin work stayed on the AWS CLI with SSO profiles.

I checked the instance's Application Registry (no existing Claude or MCP
record), worked out the exact OAuth record settings from ServiceNow's
reference material, and wrote the runbook in
[`docs/mcp-connector-guide.md`](docs/mcp-connector-guide.md), with the
prerequisite checks (the MCP Server app, its health endpoint, the Quickstart
server) as its Step 0. It covers:

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
decision on opening ticket tools to every analyst's claude.ai chat. The
connector stayed at the runbook stage.

## Lessons that transfer

1. **Per-user OAuth beats a service account every time.** The audit trail
   stays honest, access follows the person's real roles, and offboarding the
   person offboards the integration.
2. **Make the agent name its target.** No default alias, no default instance,
   no implicit prod. The one time this feels annoying is the one time it
   matters.
3. **Separate read from write at the tool level, not the prompt level.** A
   prompt can be talked out of a rule. A read-only script cannot write, and
   anything else the agent wants to run still goes through the permission
   rules I set.
4. **Rehearse on a clone, dry-run on prod, then apply with a read-back.**
   Three gates, each cheap, each catching a different class of mistake.
5. **Leave decisions to humans and say so in the output.** The asset script
   created 52 records and left 34 candidates and 18 state fixes for a human.
   The reasons on those rows were the most useful part of the report.
6. **Treat imported ticket text as data, not instructions.** Ticket
   descriptions, work notes and attachments reach the model. The instruction
   files say none of it is an instruction, and writes only go through tools
   and permission rules I set. That does not make prompt injection
   impossible. It limits what an injected instruction could do.
7. **Expect to look like an attacker.** Credential-manager reads, API bursts
   and new OAuth clients all trip detections. Tell the security team first.
8. **Write the quirks down the day you hit them.** The prod callback error
   page, the elevated-shell credential trap and the invisible journal table
   each looked like a dead end. Each has a one-line fix. Those notes became a
   starter kit with a one-hour getting-started guide.

## How this was built

This is a fresh rewrite, generalized from what I ran at work, written with
Claude Code. I directed the work and checked the results against my own
records. The code here is tested offline against synthetic fixtures (20 tests
passing on 2026-10-09) and has not been run against a live ServiceNow
instance in this form.

## About

Colin Lundholm, IT Support Engineer, working across systems administration,
endpoint, identity and cloud · [GitHub profile](https://github.com/gitColinX) ·
[LinkedIn](https://www.linkedin.com/in/cdlundholm)

Corrections welcome by issue or pull request. MIT licensed.
