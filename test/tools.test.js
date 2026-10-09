'use strict'
// Offline tests for the guards in tools/. A stub stands in for the ServiceNow
// SDK, so nothing here needs credentials, a network or an instance.
// Run with: npm test

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { query } = require('../tools/snow-table-query')
const { write, compareFields } = require('../tools/snow-table-write')
const { isProduction, UsageError } = require('../tools/lib/snow')

const SYS_ID = '0123456789abcdef0123456789abcdef'

// A stand-in for the SDK. `respond` gets each request and returns
// { status, json | text, headers }. Every request is recorded in `calls`.
function stubSdk(respond, host = 'example-dev.service-now.com') {
    const calls = []
    class Connector {
        getHost() {
            return new URL(`https://${host}`)
        }
        async fetch(urlPath, init = {}, params) {
            const call = {
                path: urlPath,
                method: init.method || 'GET',
                params: params ? Object.fromEntries(params) : {},
                body: init.body ? JSON.parse(init.body) : undefined,
            }
            calls.push(call)
            const { status = 200, json, text, headers = {} } = respond(call, calls) || {}
            const payload = text ?? (json === undefined ? null : JSON.stringify(json))
            return new Response(status === 204 ? null : payload, { status, headers })
        }
    }
    return { calls, sdk: () => ({ credentialProvider: async () => ({}), Connector }) }
}

const deps = (stub, extra = {}) => ({ sdk: stub.sdk, env: {}, ...extra })

test('query refuses to run without --auth', async () => {
    const stub = stubSdk(() => ({ json: { result: [] } }))
    await assert.rejects(query(['incident'], deps(stub)), /--auth <alias> is required/)
    assert.equal(stub.calls.length, 0)
})

test('query rejects a table name that tries to walk the URL path', async () => {
    const stub = stubSdk(() => ({ json: { result: [] } }))
    await assert.rejects(query(['../../../api/x_custom/thing', '--auth', 'dev'], deps(stub)), /Not a table name/)
    assert.equal(stub.calls.length, 0)
})

test('query refuses when SDK session variables would override --auth', async () => {
    const stub = stubSdk(() => ({ json: { result: [] } }))
    const env = { SN_SDK_INSTANCE_URL: 'https://elsewhere.service-now.com', SN_SDK_SESSION_BEARER_TOKEN: 'x' }
    await assert.rejects(query(['incident', '--auth', 'dev'], deps(stub, { env })), /would make the SDK ignore --auth/)
    assert.equal(stub.calls.length, 0)
})

test('query is GET only and reports truncation', async () => {
    const stub = stubSdk(() => ({ json: { result: [{ number: 'INC0000001' }, { number: 'INC0000002' }] }, headers: { 'X-Total-Count': '5' } }))
    const { output, exitCode } = await query(['incident', '--auth', 'dev', '--limit', '2'], deps(stub))
    assert.equal(exitCode, 0)
    assert.equal(output.count, 2)
    assert.equal(output.total, 5)
    assert.equal(output.truncated, true)
    assert.equal(output.production, false)
    assert.deepEqual(stub.calls.map((c) => c.method), ['GET'])
})

test('query keeps the HTTP status when the body is not JSON', async () => {
    const stub = stubSdk(() => ({ status: 401, text: '<html>Session expired</html>' }))
    const { output, exitCode } = await query(['incident', '--auth', 'dev'], deps(stub))
    assert.equal(exitCode, 1)
    assert.equal(output.status, 401)
    assert.match(output.error.raw, /Session expired/)
})

test('any alias not listed as non-production counts as production', () => {
    for (const alias of ['prod', 'PROD', 'production', 'prod2', 'Dev']) assert.equal(isProduction(alias, 'x.service-now.com'), true, alias)
    assert.equal(isProduction('dev', 'x.service-now.com'), false)
    const pinned = new Map([['dev', 'example-dev.service-now.com']])
    assert.equal(isProduction('dev', 'example-dev.service-now.com', pinned), false)
    assert.equal(isProduction('dev', 'example.service-now.com', pinned), true)
})

test('a write to production needs --confirm-prod, and nothing is sent without it', async () => {
    const stub = stubSdk(() => ({ json: { result: { sys_id: SYS_ID } } }), 'example.service-now.com')
    await assert.rejects(write(['patch', 'sc_task', SYS_ID, '--auth', 'production', '--data', '{"state":"3"}'], deps(stub)), /counts as production/)
    assert.equal(stub.calls.length, 0)
})

test('a pinned dev alias that resolves to another host is treated as production', async () => {
    const stub = stubSdk(() => ({ json: { result: { sys_id: SYS_ID } } }), 'example.service-now.com')
    const nonProd = new Map([['dev', 'example-dev.service-now.com']])
    await assert.rejects(write(['patch', 'sc_task', SYS_ID, '--auth', 'dev', '--data', '{"state":"3"}'], deps(stub, { nonProd })), /counts as production/)
    assert.equal(stub.calls.length, 0)
})

test('patch reads the record back and passes when every field landed', async () => {
    const stub = stubSdk((call) =>
        call.method === 'PATCH'
            ? { json: { result: { sys_id: SYS_ID } } }
            : { json: { result: { sys_id: { value: SYS_ID, display_value: SYS_ID }, state: { value: '3', display_value: 'Closed Complete' } } } }
    )
    const { output, exitCode } = await write(['patch', 'sc_task', SYS_ID, '--auth', 'dev', '--data', '{"state":"3"}'], deps(stub))
    assert.equal(exitCode, 0)
    assert.equal(output.verified, true)
    assert.deepEqual(stub.calls.map((c) => c.method), ['PATCH', 'GET'])
    assert.match(stub.calls[1].params.sysparm_fields, /\bstate\b/)
})

test('patch fails when ServiceNow silently drops a field', async () => {
    // The Table API answers 200 and ignores a misspelled field. Only the read-back shows it.
    const stub = stubSdk((call) =>
        call.method === 'PATCH'
            ? { json: { result: { sys_id: SYS_ID } } }
            : { json: { result: { sys_id: { value: SYS_ID, display_value: SYS_ID } } } }
    )
    const { output, exitCode } = await write(['patch', 'sc_task', SYS_ID, '--auth', 'dev', '--data', '{"stat":"3"}'], deps(stub))
    assert.equal(exitCode, 1)
    assert.equal(output.ok, false)
    assert.equal(output.mismatches[0].field, 'stat')
})

test('patch fails when a business rule changes the value', async () => {
    const stub = stubSdk((call) =>
        call.method === 'PATCH'
            ? { json: { result: { sys_id: SYS_ID } } }
            : { json: { result: { state: { value: '2', display_value: 'Work in Progress' } } } }
    )
    const { output, exitCode } = await write(['patch', 'sc_task', SYS_ID, '--auth', 'dev', '--data', '{"state":"3"}'], deps(stub))
    assert.equal(exitCode, 1)
    assert.equal(output.mismatches[0].got, '2')
})

test('a work note passes when the new entry appears in the journal', () => {
    const record = { work_notes: { value: '', display_value: '09/15/2026 10:00:00 AM - Someone (Work notes)\nLaptop collected\n\n' } }
    assert.deepEqual(compareFields({ work_notes: 'Laptop collected' }, record), [])
    assert.equal(compareFields({ work_notes: 'Something else' }, record).length, 1)
})

test('post takes the sys_id from the response and reads that record back', async () => {
    const stub = stubSdk((call) =>
        call.method === 'POST'
            ? { status: 201, json: { result: { sys_id: SYS_ID } } }
            : { json: { result: { name: { value: 'x', display_value: 'x' } } } }
    )
    const { output, exitCode } = await write(['post', 'u_example', '--auth', 'dev', '--data', '{"name":"x"}'], deps(stub))
    assert.equal(exitCode, 0)
    assert.equal(output.sys_id, SYS_ID)
    assert.equal(stub.calls[1].path, `/api/now/table/u_example/${SYS_ID}`)
})

test('write rejects a sys_id that is not 32 hex characters', async () => {
    const stub = stubSdk(() => ({ json: {} }))
    await assert.rejects(write(['patch', 'sc_task', '../sys_user', '--auth', 'dev', '--data', '{"a":"b"}'], deps(stub)), /Not a sys_id/)
    assert.equal(stub.calls.length, 0)
})

test('a payload file saved with a byte order mark still parses', async () => {
    const stub = stubSdk((call) =>
        call.method === 'PATCH' ? { json: { result: { sys_id: SYS_ID } } } : { json: { result: { state: { value: '3', display_value: '3' } } } }
    )
    const readFile = () => '\uFEFF{"state":"3"}'
    const { exitCode } = await write(['patch', 'sc_task', SYS_ID, '--auth', 'dev', '--data-file', 'payload.json'], deps(stub, { readFile }))
    assert.equal(exitCode, 0)
})

test('delete on production is refused outside the allow-list, even with --any-table', async () => {
    const stub = stubSdk(() => ({ json: { result: {} } }), 'example.service-now.com')
    const argv = ['delete', 'incident', SYS_ID, '--auth', 'prod', '--confirm', SYS_ID, '--any-table', '--confirm-prod']
    await assert.rejects(write(argv, deps(stub)), /not on the delete allow-list/)
    assert.equal(stub.calls.length, 0)
})

test('delete needs --confirm to repeat the sys_id', async () => {
    const stub = stubSdk(() => ({ json: { result: {} } }))
    const argv = ['delete', 'sys_user_grmember', SYS_ID, '--auth', 'dev', '--confirm', 'f'.repeat(32)]
    await assert.rejects(write(argv, deps(stub)), /--confirm/)
    assert.equal(stub.calls.length, 0)
})

test('delete snapshots raw values, deletes, and confirms the record is gone', async (t) => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snow-test-'))
    t.after(() => fs.rmSync(logDir, { recursive: true, force: true }))
    let deleted = false
    const stub = stubSdk((call) => {
        if (call.method === 'DELETE') {
            deleted = true
            return { status: 204 }
        }
        return deleted ? { status: 404, json: { error: { message: 'No Record found' } } } : { json: { result: { sys_id: SYS_ID, user: 'a', group: 'b' } } }
    })
    const argv = ['delete', 'sys_user_grmember', SYS_ID, '--auth', 'dev', '--confirm', SYS_ID]
    const { output, exitCode } = await write(argv, deps(stub, { logDir }))
    assert.equal(exitCode, 0)
    assert.equal(output.verified_gone, true)
    assert.equal(stub.calls[0].params.sysparm_display_value, 'false')
    assert.deepEqual(stub.calls.map((c) => c.method), ['GET', 'DELETE', 'GET'])
    const lines = fs.readFileSync(output.snapshot_log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(lines.map((l) => l.event), ['snapshot', 'delete'])
    assert.equal(lines[0].record.group, 'b')
    assert.equal(lines[1].verified_gone, true)
})

test('delete exits 1 when the record is still there afterwards', async (t) => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snow-test-'))
    t.after(() => fs.rmSync(logDir, { recursive: true, force: true }))
    const stub = stubSdk((call) => (call.method === 'DELETE' ? { status: 403, json: { error: { message: 'ACL' } } } : { json: { result: { sys_id: SYS_ID } } }))
    const argv = ['delete', 'sys_user_grmember', SYS_ID, '--auth', 'dev', '--confirm', SYS_ID]
    const { output, exitCode } = await write(argv, deps(stub, { logDir }))
    assert.equal(exitCode, 1)
    assert.equal(output.verified_gone, false)
})

test('unknown flags are rejected', async () => {
    const stub = stubSdk(() => ({ json: {} }))
    await assert.rejects(query(['incident', '--auth', 'dev', '--everything'], deps(stub)), UsageError)
})
