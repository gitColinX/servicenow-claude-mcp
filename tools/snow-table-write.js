#!/usr/bin/env node
/**
 * snow-table-write.js - authenticated ServiceNow Table API writes (POST/PATCH/GET)
 * reusing the credential aliases already stored by `now-sdk auth` (Windows
 * Credential Manager, per-user). Tokens are never printed.
 *
 * Usage (run from repository root so @servicenow packages resolve):
 *   node tools\snow-table-write.js get   <table> <sys_id> --auth dev [--fields a,b,c]
 *   node tools\snow-table-write.js post  <table>          --auth dev --data '{"name":"x"}'
 *   node tools\snow-table-write.js patch <table> <sys_id> --auth dev --data '{"name":"y"}'
 *   ... add --data-file payload.json instead of --data for larger payloads.
 *   node tools\snow-table-write.js delete <table> <sys_id> --auth prod --confirm <sys_id>
 *        (guarded: allow-listed link tables only, pre-read + snapshot to _deletions\, verified 404 after)
 *   node tools\snow-table-write.js delete <any_table> <sys_id> --auth dev --confirm <sys_id> --any-table
 *        (dev-only full delete: same snapshot + verify, allow-list bypassed. --any-table is IGNORED on any PROD alias.)
 *
 * --auth is REQUIRED on purpose: no silent fallback to the default alias, so a
 * write can never hit prod unintentionally. Values in --data are raw values
 * (sys_ids for references, choice values not labels). Response prints display
 * values alongside raw values for read-back verification.
 */
const fs = require('fs')
const { credentialProvider } = require('@servicenow/sdk-cli/dist/auth')
const { Connector } = require('@servicenow/sdk-api')

function fail(msg) {
    console.error(JSON.stringify({ ok: false, error: msg }))
    process.exit(1)
}

function parseArgs(argv) {
    const args = { _: [] }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--any-table') {
            args['any-table'] = true
        } else if (a === '--auth' || a === '--data' || a === '--data-file' || a === '--fields' || a === '--display-value' || a === '--confirm') {
            args[a.slice(2)] = argv[++i]
        } else if (a.startsWith('--')) {
            fail(`Unknown flag: ${a}`)
        } else {
            args._.push(a)
        }
    }
    return args
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    const [method, table, sysId] = args._
    if (!method || !['get', 'post', 'patch', 'delete'].includes(method)) fail('First arg must be get|post|patch|delete')
    if (!table) fail('Second arg must be a table name')
    if (!args.auth) fail('--auth <alias> is required (e.g. dev, prod, as stored by now-sdk auth --list)')
    if (method !== 'post' && !sysId) fail(`${method} requires a sys_id as third arg`)
    if ((method === 'get' || method === 'delete') && (args.data || args['data-file'])) fail(`${method} does not take --data`)

    if (method === 'delete') return guardedDelete(args, table, sysId)

    let body
    if (method !== 'get') {
        const raw = args['data-file'] ? fs.readFileSync(args['data-file'], 'utf8') : args.data
        if (!raw) fail(`${method} requires --data '<json>' or --data-file <path>`)
        try {
            body = JSON.stringify(JSON.parse(raw))
        } catch (e) {
            fail(`--data is not valid JSON: ${e.message}`)
        }
    }

    const credential = await credentialProvider(args.auth)
    const connector = new Connector(credential)

    const path = sysId ? `/api/now/table/${table}/${sysId}` : `/api/now/table/${table}`
    const params = new URLSearchParams({
        sysparm_display_value: args['display-value'] || 'all',
        sysparm_exclude_reference_link: 'true',
    })
    if (args.fields) params.set('sysparm_fields', args.fields)

    const res = await connector.fetch(
        path,
        {
            method: method.toUpperCase(),
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            ...(body ? { body } : {}),
        },
        params
    )

    let payload = null
    try {
        payload = await res.json()
    } catch {
        /* non-JSON body */
    }
    const out = {
        ok: res.ok,
        status: res.status,
        instance: connector.getHost().host,
        method: method.toUpperCase(),
        table,
        result: payload ? (payload.result ?? payload) : null,
    }
    console.log(JSON.stringify(out, null, 2))
    if (!res.ok) process.exit(1)
}

/**
 * Guarded delete. Deletes exactly ONE record and only when every guard passes:
 *   - table must be on the allow-list below (link/assignment rows, never business records)
 *   - --confirm <sys_id> must repeat the sys_id exactly (no copy-paste of the wrong id)
 *   - the record is read first; if it does not exist or the read fails, nothing is deleted
 *   - the pre-delete snapshot is appended to _deletions\<auth>-deletions.jsonl
 *     before the DELETE is sent, so every removal is recoverable via POST of the snapshot
 *   - a read-after-delete must return 404, otherwise exit code 1
 */
const DELETE_ALLOWED_TABLES = new Set([
    'sys_user_has_role', // direct role assignment rows
    'sys_user_grmember', // group membership rows
    'sys_group_has_role', // group role rows
    'kb_uc_can_read_mtom', 'kb_uc_cannot_read_mtom', 'kb_uc_can_contribute_mtom', 'kb_uc_cannot_contribute_mtom',
])

// Aliases that point at production. Edit to match your now-sdk auth --list output.
const PROD_ALIASES = new Set(['prod'])

async function guardedDelete(args, table, sysId) {
    const isProd = PROD_ALIASES.has(args.auth)
    if (!DELETE_ALLOWED_TABLES.has(table)) {
        if (isProd) fail(`delete is not allowed on ${table} in PROD (alias ${args.auth}). Allowed: ${[...DELETE_ALLOWED_TABLES].join(', ')}. --any-table is ignored on prod.`)
        if (!args['any-table']) fail(`delete on ${table} needs --any-table (non-prod alias ${args.auth} only). Allowed without it: ${[...DELETE_ALLOWED_TABLES].join(', ')}`)
    }
    if (!/^[0-9a-f]{32}$/.test(sysId)) fail('delete requires a 32-char sys_id')
    if (args.confirm !== sysId) fail(`delete requires --confirm ${sysId} (must match the sys_id exactly)`)

    const credential = await credentialProvider(args.auth)
    const connector = new Connector(credential)
    const host = connector.getHost().host
    const params = new URLSearchParams({ sysparm_display_value: 'all', sysparm_exclude_reference_link: 'true' })
    const path = `/api/now/table/${table}/${sysId}`

    const pre = await connector.fetch(path, { method: 'GET', headers: { Accept: 'application/json' } }, params)
    if (pre.status === 404) fail(`nothing deleted: ${table}/${sysId} does not exist on ${host}`)
    if (!pre.ok) fail(`nothing deleted: pre-read failed with HTTP ${pre.status}`)
    const snapshot = (await pre.json()).result

    const logDir = require('path').join(process.cwd(), '_deletions')
    fs.mkdirSync(logDir, { recursive: true })
    const logFile = `${logDir}\\${args.auth}-deletions.jsonl`
    fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), instance: host, table, sys_id: sysId, record: snapshot }) + '\n')

    const del = await connector.fetch(path, { method: 'DELETE', headers: { Accept: 'application/json' } })
    const post = await connector.fetch(path, { method: 'GET', headers: { Accept: 'application/json' } }, params)
    const gone = post.status === 404
    const out = {
        ok: (del.status === 204 || del.status === 200) && gone,
        status: del.status,
        instance: host,
        method: 'DELETE',
        table,
        sys_id: sysId,
        mode: DELETE_ALLOWED_TABLES.has(table) ? 'guarded' : 'full (non-prod, --any-table)',
        verified_gone: gone,
        snapshot_logged_to: logFile,
        deleted_record: snapshot,
    }
    console.log(JSON.stringify(out, null, 2))
    if (!out.ok) process.exit(1)
}

main().catch((e) => fail(e.message))
