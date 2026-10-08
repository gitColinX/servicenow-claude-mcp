#!/usr/bin/env node
'use strict'
/**
 * snow-table-query.js - READ-ONLY ServiceNow Table API list query riding the
 * OAuth aliases stored by `now-sdk auth`. Companion to snow-table-write.js
 * (which reads single records by sys_id and does the writes).
 *
 * Usage (from repo root so @servicenow packages resolve):
 *   node tools\snow-table-query.js <table> --auth prod [--query "<encoded query>"]
 *        [--fields a,b,c] [--limit 20] [--display true|false|all] [--count]
 *
 * Examples:
 *   node tools\snow-table-query.js change_request --auth prod --query "active=true^state=-3" --fields number,short_description,start_date
 *   node tools\snow-table-query.js cmn_schedule_span --auth prod --query "schedule.type=blackout" --fields schedule,name,start_date_time,end_date_time
 *   node tools\snow-table-query.js sys_user_has_role --auth prod --query "user.user_name=<user>@example.com" --fields role --limit 300
 *
 * Prints JSON: { table, status, total (X-Total-Count), count, rows }. Tokens are never printed.
 * GET only - there is no way to write with this tool.
 */
const { credentialProvider } = require('@servicenow/sdk-cli/dist/auth')
const { Connector } = require('@servicenow/sdk-api')

function fail(msg) { console.error(JSON.stringify({ ok: false, error: msg })); process.exit(1) }

function parseArgs(argv) {
    const a = { _: [], limit: '20', display: 'true' }
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i]
        if (k === '--count') a.count = true
        else if (['--auth', '--query', '--fields', '--limit', '--display', '--offset'].includes(k)) a[k.slice(2)] = argv[++i]
        else if (k.startsWith('--')) fail(`Unknown flag: ${k}`)
        else a._.push(k)
    }
    return a
}

async function main() {
    const a = parseArgs(process.argv.slice(2))
    const table = a._[0]
    if (!table) fail('First arg must be a table name')
    if (!a.auth) fail('--auth <alias> is required (for example prod or dev, as stored by now-sdk auth --list)')
    const connector = new Connector(await credentialProvider(a.auth))
    const params = new URLSearchParams({
        sysparm_display_value: a.display,
        sysparm_exclude_reference_link: 'true',
        sysparm_limit: a.count ? '1' : a.limit,
    })
    if (a.query) params.set('sysparm_query', a.query)
    if (a.fields) params.set('sysparm_fields', a.count ? 'sys_id' : a.fields)
    if (a.offset) params.set('sysparm_offset', a.offset)
    const res = await connector.fetch(`/api/now/table/${table}`, { method: 'GET', headers: { Accept: 'application/json' } }, params)
    const total = res.headers && res.headers.get ? res.headers.get('X-Total-Count') : undefined
    let body
    try { body = await res.json() } catch { body = { raw: await res.text() } }
    if (a.count) console.log(JSON.stringify({ table, status: res.status, total: total != null ? Number(total) : undefined, query: a.query || '' }))
    else console.log(JSON.stringify({ table, status: res.status, total: total != null ? Number(total) : undefined, count: body.result ? body.result.length : undefined, rows: body.result || body }, null, 1))
    if (res.status !== 200) process.exit(1)
}

main().catch((e) => fail(e.message))
