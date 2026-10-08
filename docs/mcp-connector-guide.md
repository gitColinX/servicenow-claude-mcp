# Connecting Claude to ServiceNow over MCP

A field guide to wiring claude.ai to a ServiceNow instance through ServiceNow's
native MCP (Model Context Protocol) Server, with OAuth delegated per user, so
Claude can read and update tickets as the signed-in analyst and every action
lands in the ServiceNow audit trail under that person's name.

This is the sanitized runbook I wrote in September 2026 for standing this up on
a production ServiceNow instance (Zurich release), after verifying the
prerequisites and the OAuth record settings on that instance. Instance names,
people, ticket numbers and internal references are removed. The story around
it, including the ServiceNow SDK path that was already in daily use, is in the
[repository README](../README.md).

```
claude.ai  --OAuth (Authorization Code, JWT)-->  ServiceNow Application Registry
claude.ai  --MCP over HTTPS------------------->  /sncapps/mcp-server/mcp/<server>
                                                 └─ tools: get/update incident, get/update catalog task ...
```

## Why this design

- **No shared service account.** Each user authorizes Claude against their own
  ServiceNow login. The token carries their roles and nothing more, and the
  audit log says who did what.
- **ServiceNow decides what Claude can call.** The MCP server exposes an
  explicit tool list. Claude never sees a raw Table API.
- **Prove the pipe before building on it.** Connect the plugin's read-only
  Quickstart server first, then build the real tool set.
- **Verify in the record, not in the chat.** Claude's "done" is a claim. The
  work note on the ticket is the evidence.

## Prerequisites

| Requirement | Notes |
|---|---|
| ServiceNow Zurich Patch 4 or later | Earlier releases do not ship the MCP Server app |
| Now Assist licensing (Pro Plus / Enterprise Plus) or an AI SKU | The MCP Server app is not part of base ITSM. If it does not appear under All Available Applications, that is a licensing question for your account team, not a permissions problem |
| `Now Assist Admin Console` (sn_nowassist_admin) installed | Dependency of the MCP server app |
| `Model Context Protocol Server` (sn_mcp_server) installed | Provides the MCP Server Console, the Quickstart server, and the `/sncapps/mcp-server/` endpoints |
| A ServiceNow account with `admin`, or `sn_mcp_server.admin` plus rights to create Application Registry records | Needed once, for setup |
| A claude.ai plan that supports custom connectors | Pro, Max, Team or Enterprise |

## Quick reference: what the Claude connect form needs

The ServiceNow entry in the claude.ai Connectors Directory asks for three
values. All three are produced on the ServiceNow side first.

| Claude form field | Value | Where it comes from |
|---|---|---|
| Server URL | `https://<instance>.service-now.com/sncapps/mcp-server/mcp/<server-name>` | MCP Server Console > Servers > open the server > Server URL field (Step 2) |
| OAuth Client ID | 32 hex characters, auto generated | Application Registry record (Step 1) |
| OAuth Client Secret | auto generated, revealed with the lock icon | Same record (Step 1) |

Values that must be exact on the ServiceNow side:

| Setting | Required value | What happens if it is wrong |
|---|---|---|
| Redirect URL | `https://claude.ai/api/mcp/auth_callback` (optionally also `https://claude.com/api/mcp/auth_callback`, comma separated). No trailing slash. | OAuth page errors or loops back to the form |
| Token Format | `JWT` | Default is Opaque. It connects, then exposes zero tools |
| Grant type | Authorization Code | Record created as Resource Owner Password Credentials never shows a consent screen |
| Auth Scope | `useraccount` | Token has no API access |
| Client Type | Confidential (default) | |

## Bookmarks

Every URL used in this setup, with `<instance>` as the placeholder.

| Purpose | URL or path |
|---|---|
| MCP server health check | `https://<instance>.service-now.com/sncapps/mcp-server/health` |
| MCP service records (sys_service) | `/nav_to.do?uri=sys_service_list.do%3Fsysparm_query%3DnameLIKEmcp` |
| All Available Applications (app install) | `/nav_to.do?uri=%24allappsmgmt.do` |
| Application Registry list (classic UI) | `/nav_to.do?uri=oauth_entity_list.do` |
| Inbound Integrations (Machine Identity Console, new UI) | `/now/machine-identity-console/inbound-integrations/welcome` |
| Inbound API Integration Usage dashboard | Banner link on the Inbound Integrations page |
| MCP Server Console | Filter Navigator: type `MCP Server Console` (under Admin Center) |
| Claude connector directory entry | https://claude.ai/directory/connectors/servicenow/connect |
| Claude connector settings | claude.ai > Customize > Connectors |
| ServiceNow Developer Advocate walkthrough (Sep 2026) | https://www.servicenow.com/community/developer-advocate-blog/building-an-mcp-server-on-servicenow-and-connecting-claude-to-it/ba-p/3588171 |
| ServiceNow HRSD MCP client tutorial (redirect URL, JWT, useraccount) | https://www.servicenow.com/community/servicenow-otto-articles/quick-tutorial-mcp-client-to-servicenow-hrsd-mcp-server/ta-p/3589606 |

## Step 0: verify the MCP Server app is installed and healthy

Do this before touching OAuth. If the app is not there, nothing else in this
guide works.

1. Open `https://<instance>.service-now.com/sncapps/mcp-server/health`.
   Expected: `{"status":"healthy"}`. A 404 or an HTML error page means the app
   is not installed.
2. Open the sys_service list filtered on `mcp`. Expected: two records,
   `MCP-S` and `mcp-server`. Open `mcp-server` and confirm the Service
   Endpoints related list has a record with Active = true.
3. Filter Navigator: type `MCP Server Console`. Expected: it appears under
   Admin Center and opens with Servers and Tools tabs.

If any of the three fail, install the app:

1. Open All Available Applications.
2. Search `Now Assist Admin Console` (sn_nowassist_admin). Install it first if
   it is not already installed.
3. Search `Model Context Protocol Server` (sn_mcp_server). Install.
4. Re-run the health URL.

## Step 1: create the OAuth Application Registry record

This produces the Client ID and Client Secret. Two UIs exist on Zurich; either
works. The classic list is the one the reference walkthrough was verified on.

Where: `/nav_to.do?uri=oauth_entity_list.do`

1. Click **New** next to Application Registries.
2. On the interceptor page choose **Create an OAuth API endpoint for external
   clients**. On Zurich it may be labeled "[Deprecated UI] Create an OAuth API
   endpoint for external clients". That is still the correct choice.
3. Fill in the form:

   | Field | Value |
   |---|---|
   | Name | `Claude MCP Connector` |
   | Client ID | leave blank, auto generates on save |
   | Client Secret | leave blank, auto generates on save |
   | Redirect URL | `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback` |
   | Token Format | `JWT` |
   | Client Type | Confidential (default) |
   | Refresh Token Lifespan | leave default (8,640,000 seconds, 100 days) |
   | Access Token Lifespan | leave default (1,800 seconds) |
   | Comments | who created it, when, and what it is for |

4. Scroll to the **Auth Scopes** embedded list at the bottom. Double click
   "Insert a new row", type `useraccount`, press Enter.
5. Right click the form header and choose **Save** (not Submit) so the form
   stays open.
6. Copy the **Client ID**.
7. Click the lock icon next to **Client Secret** to reveal it. Copy it
   somewhere temporary. It gets pasted into Claude within minutes and then
   belongs in your team's password vault, labeled with the registry record
   name. Never write it into a document.

Alternative path, same result: Inbound Integrations (Machine Identity Console)
> **New integration** > grant type Authorization Code > same field values. The
new UI shows the grant type as a column, which is a quick way to confirm the
record landed as Authorization Code and not Resource Owner Password
Credentials.

## Step 2: pick or create the MCP server and copy its Server URL

The Server URL is `https://<instance>.service-now.com/sncapps/mcp-server/mcp/`
plus the name segment of a specific MCP server record. That segment does not
exist until a server record exists.

Where: Filter Navigator > `MCP Server Console`.

### Fast path: prove the pipe first

1. **Servers** tab.
2. Open **Quickstart Server**. It ships with the app and carries four read-only
   tools: look up incident, look up case, summarize incident, summarize case.
3. Confirm it shows **Deactivate** (meaning it is active). If it shows
   **Activate**, click it.
4. Copy the **Server URL** field. That is the Claude Server URL.

### Real path: the service desk tool set

Do this after the Quickstart connection works end to end.

1. **Tools** tab > **Create Tool** > choose a category. For reading and
   updating tasks, the two candidates are the REST API tool (Scripted REST or
   Table API endpoint) and the Table tool. Each tool needs a Label, a
   Description written for the model (what it does, then when to call it), and
   its inputs.
2. A minimum tool set for a service desk workflow:

   | Tool | Shape |
   |---|---|
   | Get Catalog Task | GET `sc_task` by number. Returns state, assigned_to, short_description, description, variables |
   | Update Catalog Task | PATCH `sc_task` by number. Accepts work_notes, comments, state, assigned_to, close_notes |
   | Get Incident | GET `incident` by number, same fields |
   | Update Incident | PATCH `incident` by number, same inputs |

3. **Servers** tab > **Create Server** > give it a label > **Add Tools** >
   select the tools > **Create** > **Activate**.
4. Copy that server's **Server URL**. Either repoint the existing Claude
   connection at it, or add it as a second connector.

Role required to create tools: `sn_mcp_server.tools_admin`,
`sn_mcp_server.admin`, or `admin`. Every server needs at least one tool before
it can be activated, so tools come before servers.

## Step 3: fill in the Claude connect form and authorize

Where: claude.ai > Customize > Connectors > Browse connectors > ServiceNow, or
directly https://claude.ai/directory/connectors/servicenow/connect.

1. Server URL: paste from Step 2.
2. OAuth Client ID: paste from Step 1.
3. OAuth Client Secret: paste from Step 1.
4. Click **Connect**.
5. You are redirected to your ServiceNow instance. If it bounces through your
   identity provider's SSO first (Entra ID, Okta, and so on), that is normal.
   Sign in as yourself.
6. ServiceNow consent screen: "Connect your ServiceNow account to Claude MCP
   Connector" with scope `useraccount`. Click **Allow**.
7. You land back in claude.ai with the connector showing Connected.
8. In a chat, click **+** > **Connectors** and make sure the ServiceNow toggle
   is on for that conversation.

The consent screen is the control point. ServiceNow is not handing Claude a
blanket key. You are approving one registered application for one scope under
your own login. Anything Claude does through it shows up in ServiceNow audit
as you.

## Step 4: test read and write, then verify in ServiceNow

Where: a new claude.ai chat with the ServiceNow connector toggled on.

1. **Read test.** Prompt: `Get the details of ServiceNow incident INC0000001.`
   Claude asks permission to run the tool the first time. Allow it. Expect
   number, short description, state, assigned to, opened date.
2. **Write test.** Only once your own server with an update tool exists; the
   Quickstart server is read-only. Prompt:
   `Add a work note to SCTASK0000001 that says "Claude connector test, ignore."`
3. Open the record in ServiceNow and confirm the work note is there under your
   name. Claude's confirmation says it thinks it worked. The record says it
   did.
4. Optional: the Inbound API Integration Usage dashboard shows calls per OAuth
   client, so you can watch the connector row light up.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Health URL returns 404 or an HTML page | sn_mcp_server not installed or not activated | Step 0 install, then re-test |
| Connector shows Connected but zero tools | Token Format left on Opaque | Open the registry record, set Token Format = JWT, save, then disconnect and reconnect in claude.ai |
| OAuth page errors or loops back to the form | Redirect URL typo, trailing slash, or missing | Redirect URL must be exactly `https://claude.ai/api/mcp/auth_callback` |
| Consent screen never appears, straight to an error | Wrong grant type (record created as Resource Owner Password Credentials) | Check the Inbound Grant Type column on the Inbound Integrations page. Recreate via the "external clients" interceptor if it is not Authorization Code |
| Connected, tools listed, but calls return 403 or empty | Your account lacks the role for that table | `useraccount` delegates your own permissions only. Confirm `itil` or the relevant table role on your user |
| Connected, but an expected tool is missing | Tool not added to the server, or server not activated | MCP Server Console > Servers > open server > Add Tools, then Activate |
| Works for you, fails for a teammate | They have not authorized. The connection is per user | Each person clicks Connect and Allow with their own login. Same registry record, same Client ID and Secret |
| Secret lost | Cannot be re-revealed once regenerated | Regenerate the Client Secret on the registry record, update the Claude connector, everyone reconnects |

## Security notes and hardening

`useraccount` is the fast path, not the end state. It grants the token access
to every REST API on the instance under the authorized user's own roles. The
MCP server narrows what Claude can call to the tools on that server, but the
token itself is broad.

Before the first write against a real ticket:

- [ ] Tell the ServiceNow platform owner the connector exists and where the
      registry record is.
- [ ] Put the Client Secret in the team password vault, labeled with the
      registry record name. Not in a doc, not in a chat.
- [ ] Decide whether the connector is shared org-wide (Claude Team/Enterprise
      admins add it under Organization settings > Connectors) or stays on
      individual accounts.

Once the tool set is settled:

- [ ] Replace `useraccount` with a custom auth scope limited to the REST paths
      the tools actually call.
- [ ] Review the Inbound API Integration Usage dashboard after two weeks of
      use and compare call volume against expectations.
- [ ] Treat ticket content reaching Claude as untrusted data. Text in a
      description or work note is never an instruction to the model.

## Alternative path: Claude Code plus the ServiceNow SDK

claude.ai web chat can only reach ServiceNow through a connector like the one
above. Claude Code (terminal or desktop app) can instead use the ServiceNow
SDK's own OAuth login and small local scripts. I used both, for different
jobs: the MCP connector for analysts working tickets in chat, and the SDK path
for admin work like Change Advisory Board prep and offboarding audits.

```powershell
npm install @servicenow/sdk-cli @servicenow/sdk-api
npx now-sdk auth --add https://<dev-instance>.service-now.com  --type oauth --alias dev
npx now-sdk auth --add https://<prod-instance>.service-now.com --type oauth --alias prod
npx now-sdk auth --list
```

Lessons from that path:

- Use `--type oauth`, never `--type basic`. Under SSO your ServiceNow password
  is not what you type into Windows, so basic auth fails.
- Add the alias from a normal, non-elevated shell as your everyday account.
  The credential is stored per Windows user, and Claude Code runs as you.
- On some instances the OAuth callback lands on a "Security constraints
  prevent access to requested page" error. That is expected. Copy the `code=`
  value from the address bar and paste it into the terminal.
- Give Claude two scripts, not one: a **read-only query tool** (GET only, no
  way to write) and a **write tool** that requires an explicit `--auth <alias>`
  on every call, so nothing can fall through to prod by default, and that reads
  the record back after writing so the output is evidence rather than a claim.
- Rehearse anything bulk or unusual against a dev clone first.
- `sys_journal_field` can return zero rows with no error through the SDK
  account. Read work notes and comments from the task record instead.

## About

Written by [Colin Lundholm](https://github.com/gitColinX) from a working
deployment. Corrections and additions welcome by issue or pull request.
