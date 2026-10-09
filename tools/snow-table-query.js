#!/usr/bin/env node
'use strict'
/**
 * snow-table-query.js: read-only list queries against the ServiceNow Table
 * API, signed in through an alias stored by `now-sdk auth`.
 *
 * GET is the only HTTP method in this file. Writes live in snow-table-write.js.
 */
const { UsageError, parseArgs, checkTable, checkWholeNumber, openTarget, tablePath, readBody, runCli } = require('./lib/snow')

const USAGE = `Read-only ServiceNow Table API query.

  node tools/snow-table-query.js <table> --auth <alias>
       [--query "<encoded query>"] [--fields a,b,c] [--limit 20] [--offset 0]
       [--display true|false|all] [--count]

Prints one JSON document: ok, instance, production, table, status, total,
count, truncated and rows. With --count, only the total.
`

async function query(argv, deps = {}) {
    const { positional, flags } = parseArgs(argv, {
        values: ['auth', 'query', 'fields', 'limit', 'offset', 'display'],
        switches: ['count'],
    })
    if (positional.length !== 1) throw new UsageError('Give exactly one table name')
    const table = checkTable(positional[0])
    const limit = checkWholeNumber(flags.limit ?? '20', '--limit', 1)
    const offset = checkWholeNumber(flags.offset ?? '0', '--offset')
    const display = flags.display ?? 'true'
    if (!['true', 'false', 'all'].includes(display)) throw new UsageError('--display must be true, false or all')

    const target = await openTarget(flags.auth, deps)
    const params = new URLSearchParams({
        sysparm_display_value: display,
        sysparm_exclude_reference_link: 'true',
        sysparm_limit: flags.count ? '1' : String(limit),
        sysparm_offset: String(offset),
    })
    if (flags.query) params.set('sysparm_query', flags.query)
    if (flags.count) params.set('sysparm_fields', 'sys_id')
    else if (flags.fields) params.set('sysparm_fields', flags.fields)

    const res = await target.connector.fetch(tablePath(table), { method: 'GET', headers: { Accept: 'application/json' } }, params)
    const body = await readBody(res)
    const header = res.headers.get('X-Total-Count')
    const total = header === null ? null : Number(header)
    const ok = res.status === 200

    const output = { ok, instance: target.host, production: target.production, table, status: res.status, total }
    if (!ok) {
        output.error = body
    } else if (flags.count) {
        output.query = flags.query ?? ''
    } else {
        const rows = Array.isArray(body?.result) ? body.result : []
        output.count = rows.length
        output.truncated = total === null ? rows.length === limit : offset + rows.length < total
        output.rows = rows
    }
    return { output, exitCode: ok ? 0 : 1 }
}

module.exports = { query, USAGE }

if (require.main === module) runCli(query, USAGE)
