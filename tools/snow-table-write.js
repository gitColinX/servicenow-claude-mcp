#!/usr/bin/env node
'use strict'
/**
 * snow-table-write.js: single-record ServiceNow Table API reads and writes,
 * signed in through an alias stored by `now-sdk auth`.
 *
 * After every post or patch the tool reads the record again with a separate
 * GET and compares each field it sent with what the record now holds. The
 * Table API answers 200 even when it silently ignores a misspelled field or a
 * field a write ACL blocks, so the response to the write is not evidence. The
 * read-back is. Any difference sets ok:false and exit code 1.
 *
 * Payload values are raw values: sys_ids for references, choice values rather
 * than labels, UTC date-times.
 */
const fs = require('fs')
const path = require('path')
const { UsageError, parseArgs, isSysId, checkTable, checkSysId, openTarget, tablePath, readBody, runCli } = require('./lib/snow')

const USAGE = `Single-record ServiceNow Table API writes, each one read back and compared.

  node tools/snow-table-write.js get    <table> <sys_id> --auth <alias> [--fields a,b,c]
  node tools/snow-table-write.js post   <table>          --auth <alias> --data '<json>'
  node tools/snow-table-write.js patch  <table> <sys_id> --auth <alias> --data '<json>'
  node tools/snow-table-write.js delete <table> <sys_id> --auth <alias> --confirm <sys_id>

  --data-file <path>  read the JSON payload from a file instead of --data
  --confirm-prod      required for any write to an alias that counts as production
  --any-table         delete outside the allow-list (refused on production)
`

// Rows that only link two records together. Deleting one removes a role, a
// membership or a knowledge access grant, never a business record. On
// production these are the only tables a delete is allowed on.
const DELETE_ALLOW_LIST = new Set([
    'sys_user_has_role',
    'sys_user_grmember',
    'sys_group_has_role',
    'kb_uc_can_read_mtom',
    'kb_uc_cannot_read_mtom',
    'kb_uc_can_contribute_mtom',
    'kb_uc_cannot_contribute_mtom',
])

// Journal fields are append-only. Reading one back returns the whole journal,
// so the check is that the new entry appears in it.
const JOURNAL_FIELDS = new Set(['work_notes', 'comments'])

const READ_HEADERS = { Accept: 'application/json' }
const WRITE_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' }

async function write(argv, deps = {}) {
    const { positional, flags } = parseArgs(argv, {
        values: ['auth', 'data', 'data-file', 'fields', 'confirm'],
        switches: ['confirm-prod', 'any-table'],
    })
    const [method, table, sysId, ...extra] = positional
    if (!['get', 'post', 'patch', 'delete'].includes(method)) throw new UsageError('First argument must be get, post, patch or delete')
    if (extra.length) throw new UsageError(`Unexpected argument: ${extra[0]}`)
    checkTable(table)
    if (method === 'post') {
        if (sysId !== undefined) throw new UsageError('post creates a record, so it takes no sys_id')
    } else {
        checkSysId(sysId)
    }

    const sendsPayload = method === 'post' || method === 'patch'
    if (!sendsPayload && (flags.data || flags['data-file'])) throw new UsageError(`${method} does not take a payload`)
    if (method !== 'delete' && (flags.confirm || flags['any-table'])) throw new UsageError('--confirm and --any-table only apply to delete')
    const payload = sendsPayload ? readPayload(flags, deps.readFile) : null

    const target = await openTarget(flags.auth, deps)
    if (method !== 'get' && target.production && !flags['confirm-prod']) {
        throw new UsageError(
            `Nothing sent. Alias ${target.alias} resolves to ${target.host}, which counts as production. ` +
                'Add --confirm-prod if this write is meant for production.'
        )
    }

    if (method === 'get') return getRecord(target, table, sysId, flags.fields)
    if (method === 'delete') return guardedDelete(target, table, sysId, flags, deps)
    return writeAndVerify(target, method, table, sysId, payload)
}

function readPayload(flags, readFile = fs.readFileSync) {
    if (flags.data && flags['data-file']) throw new UsageError('Use --data or --data-file, not both')
    const text = flags['data-file'] ? readFile(flags['data-file'], 'utf8').replace(/^\uFEFF/, '') : flags.data
    if (!text) throw new UsageError('post and patch need --data <json> or --data-file <path>')
    let payload
    try {
        payload = JSON.parse(text)
    } catch (err) {
        throw new UsageError(`The payload is not valid JSON: ${err.message}`)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length === 0) {
        throw new UsageError('The payload must be a JSON object with at least one field')
    }
    return payload
}

const summary = (target, method, table) => ({ instance: target.host, production: target.production, method, table })

async function fetchRecord(connector, table, sysId, { display = 'all', fields } = {}) {
    const params = new URLSearchParams({ sysparm_display_value: display, sysparm_exclude_reference_link: 'true' })
    if (fields) params.set('sysparm_fields', fields)
    const res = await connector.fetch(tablePath(table, sysId), { method: 'GET', headers: READ_HEADERS }, params)
    const body = await readBody(res)
    const record = res.status === 200 && body && body.result ? body.result : null
    return { status: res.status, record, body }
}

async function getRecord(target, table, sysId, fields) {
    const got = await fetchRecord(target.connector, table, sysId, { fields })
    const ok = got.record !== null
    const output = { ok, ...summary(target, 'GET', table), status: got.status, sys_id: sysId, record: got.record }
    if (!ok) output.error = got.body
    return { output, exitCode: ok ? 0 : 1 }
}

async function writeAndVerify(target, method, table, sysId, payload) {
    const verb = method.toUpperCase()
    const params = new URLSearchParams({ sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true', sysparm_fields: 'sys_id' })
    const res = await target.connector.fetch(tablePath(table, sysId), { method: verb, headers: WRITE_HEADERS, body: JSON.stringify(payload) }, params)
    const body = await readBody(res)
    const base = summary(target, verb, table)
    if (!res.ok) {
        return { output: { ok: false, ...base, status: res.status, sys_id: sysId ?? null, error: body }, exitCode: 1 }
    }

    const id = sysId ?? body?.result?.sys_id
    if (!isSysId(id)) {
        const error = 'ServiceNow accepted the write but returned no sys_id, so it could not be read back. Check the table by hand.'
        return { output: { ok: false, ...base, status: res.status, sys_id: null, error }, exitCode: 1 }
    }

    const fields = [...new Set(['sys_id', 'number', 'sys_updated_on', 'sys_updated_by', ...Object.keys(payload)])].join(',')
    const after = await fetchRecord(target.connector, table, id, { fields })
    if (after.record === null) {
        const error = `The write returned HTTP ${res.status}, but the read-back returned HTTP ${after.status}`
        return { output: { ok: false, ...base, status: res.status, sys_id: id, verified: false, error, read_back: after.body }, exitCode: 1 }
    }

    const mismatches = compareFields(payload, after.record)
    const verified = mismatches.length === 0
    return { output: { ok: verified, ...base, status: res.status, sys_id: id, verified, mismatches, record: after.record }, exitCode: verified ? 0 : 1 }
}

const asText = (value) => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))

/** Compare what was sent with a record read back using sysparm_display_value=all. */
function compareFields(sent, record) {
    const mismatches = []
    for (const [field, wanted] of Object.entries(sent)) {
        const got = record[field]
        if (got === undefined) {
            mismatches.push({ field, sent: wanted, problem: 'not in the read-back (unknown field, or no read access)' })
            continue
        }
        const pair = got !== null && typeof got === 'object'
        const raw = pair ? got.value : got
        const display = pair ? got.display_value : got
        if (JOURNAL_FIELDS.has(field)) {
            const entry = asText(wanted).trim()
            if (!asText(display).includes(entry) && !asText(raw).includes(entry)) {
                mismatches.push({ field, sent: wanted, problem: 'new journal entry not found in the read-back' })
            }
        } else if (asText(raw) !== asText(wanted)) {
            mismatches.push({ field, sent: wanted, got: raw, problem: 'value differs after the write' })
        }
    }
    return mismatches
}

/**
 * Delete exactly one record, and only when every guard passes:
 *   - --confirm repeats the sys_id exactly
 *   - the table is on the allow-list, or the target is non-production and
 *     --any-table was given
 *   - the record exists and its raw values are appended to a local JSONL log
 *     before the DELETE is sent, so it can be restored with a POST
 *   - a read after the delete must return 404, otherwise exit code 1
 */
async function guardedDelete(target, table, sysId, flags, deps = {}) {
    if (flags.confirm !== sysId) throw new UsageError(`delete needs --confirm ${sysId}, repeating the sys_id exactly`)
    const listed = DELETE_ALLOW_LIST.has(table)
    if (!listed && target.production) {
        throw new UsageError(
            `Refused. ${table} is not on the delete allow-list, and ${target.host} counts as production, where --any-table is not accepted. ` +
                `Allowed: ${[...DELETE_ALLOW_LIST].join(', ')}`
        )
    }
    if (!listed && !flags['any-table']) {
        throw new UsageError(`${table} is not on the delete allow-list. On a non-production instance, add --any-table to delete it anyway.`)
    }

    const { connector, host } = target
    const before = await fetchRecord(connector, table, sysId, { display: 'false' })
    if (before.status === 404) throw new UsageError(`Nothing deleted: ${table}/${sysId} does not exist on ${host}`)
    if (before.record === null) throw new UsageError(`Nothing deleted: the pre-read returned HTTP ${before.status}`)

    const log = deletionLog(target.alias, deps.logDir)
    log.append({ event: 'snapshot', instance: host, table, sys_id: sysId, record: before.record })

    const del = await connector.fetch(tablePath(table, sysId), { method: 'DELETE', headers: READ_HEADERS })
    await readBody(del)
    const after = await fetchRecord(connector, table, sysId, { display: 'false', fields: 'sys_id' })
    const accepted = del.status === 200 || del.status === 204
    const gone = after.status === 404
    log.append({ event: 'delete', instance: host, table, sys_id: sysId, delete_status: del.status, verified_gone: gone })

    const ok = accepted && gone
    const output = {
        ok,
        ...summary(target, 'DELETE', table),
        status: del.status,
        sys_id: sysId,
        mode: listed ? 'allow-listed table' : 'any table (non-production)',
        verified_gone: gone,
        snapshot_log: log.file,
        deleted_record: before.record,
    }
    return { output, exitCode: ok ? 0 : 1 }
}

function deletionLog(alias, dir = path.join(process.cwd(), '_deletions')) {
    const file = path.join(dir, `${alias.replace(/[^A-Za-z0-9_.-]/g, '_')}-deletions.jsonl`)
    return {
        file,
        append(entry) {
            fs.mkdirSync(dir, { recursive: true })
            fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
        },
    }
}

module.exports = { write, compareFields, DELETE_ALLOW_LIST, USAGE }

if (require.main === module) runCli(write, USAGE)
