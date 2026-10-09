'use strict'
/**
 * Shared plumbing for snow-table-query.js and snow-table-write.js.
 *
 * - argument parsing that rejects unknown flags
 * - input checks, so a table name or sys_id can never steer the request path
 * - target resolution: which instance an alias points at, and whether it
 *   counts as production (anything not explicitly listed as non-production does)
 * - one JSON document on stdout per run; everything else goes to stderr
 *
 * The ServiceNow SDK is loaded lazily, so the offline tests run without it.
 */

// Aliases from `now-sdk auth --list` that may be treated as non-production.
// Pin an alias to the host it must resolve to, and it only counts as
// non-production while it really points there. Every other alias, in any
// spelling or case, is production.
const NON_PROD_TARGETS = new Map([
    ['dev', null], // for example ['dev', 'yourcompanydev.service-now.com']
])

// When any of these are set, the SDK uses them and ignores the alias you named.
const SESSION_OVERRIDES = ['SN_SDK_INSTANCE_URL', 'SN_SDK_SESSION_TOKEN', 'SN_SDK_SESSION_COOKIE', 'SN_SDK_SESSION_BEARER_TOKEN']

const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/
const SYS_ID = /^[0-9a-f]{32}$/

class UsageError extends Error {}

function parseArgs(argv, { values = [], switches = [] } = {}) {
    const positional = []
    const flags = {}
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i]
        if (!token.startsWith('--')) {
            positional.push(token)
            continue
        }
        const name = token.slice(2)
        if (switches.includes(name)) {
            flags[name] = true
            continue
        }
        if (!values.includes(name)) throw new UsageError(`Unknown flag: ${token}`)
        const value = argv[i + 1]
        if (value === undefined || value.startsWith('--')) throw new UsageError(`${token} needs a value`)
        flags[name] = value
        i++
    }
    return { positional, flags }
}

const isSysId = (value) => typeof value === 'string' && SYS_ID.test(value)

function checkTable(name) {
    if (typeof name !== 'string' || !TABLE_NAME.test(name)) throw new UsageError(`Not a table name: ${name ?? '(missing)'}`)
    return name
}

function checkSysId(value) {
    if (!isSysId(value)) throw new UsageError(`Not a sys_id (32 lowercase hex characters): ${value ?? '(missing)'}`)
    return value
}

function checkWholeNumber(text, flag, min = 0) {
    if (!/^\d+$/.test(String(text)) || Number(text) < min) throw new UsageError(`${flag} must be a whole number of at least ${min}`)
    return Number(text)
}

function isProduction(alias, host, nonProd = NON_PROD_TARGETS) {
    if (!nonProd.has(alias)) return true
    const pinned = nonProd.get(alias)
    return Boolean(pinned) && pinned.toLowerCase() !== String(host).toLowerCase()
}

function refuseSessionOverrides(env = process.env) {
    const found = SESSION_OVERRIDES.filter((name) => env[name])
    if (env.SN_SDK_NODE_ENV === 'SN_SDK_CI_INSTALL') found.push('SN_SDK_NODE_ENV')
    if (found.length) {
        throw new UsageError(`Refusing to run: ${found.join(', ')} would make the SDK ignore --auth. Unset ${found.length === 1 ? 'it' : 'them'} and try again.`)
    }
}

function loadSdk() {
    // The SDK logs with console.log, including its token-refresh notice. Send
    // that to stderr before the SDK loads, so stdout stays one JSON document.
    console.log = (...args) => console.error(...args)
    const { credentialProvider } = require('@servicenow/sdk-cli/dist/auth')
    const { Connector } = require('@servicenow/sdk-api')
    return { credentialProvider, Connector }
}

/**
 * Resolve an alias to a connector without sending anything over the network.
 * Tests pass their own `sdk`, `env` and `nonProd`.
 */
async function openTarget(alias, { sdk = loadSdk, env = process.env, nonProd = NON_PROD_TARGETS } = {}) {
    if (!alias) throw new UsageError('--auth <alias> is required. There is no default target.')
    refuseSessionOverrides(env)
    const { credentialProvider, Connector } = sdk()
    const connector = new Connector(await credentialProvider(alias))
    const host = connector.getHost().host
    return { alias, host, production: isProduction(alias, host, nonProd), connector }
}

function tablePath(table, sysId) {
    const base = `/api/now/table/${checkTable(table)}`
    return sysId === undefined ? base : `${base}/${checkSysId(sysId)}`
}

// Read the body exactly once. An HTML error page or an empty body must not
// hide the HTTP status behind a parse error.
async function readBody(res) {
    const text = await res.text()
    if (!text) return null
    try {
        return JSON.parse(text)
    } catch {
        return { raw: text.slice(0, 2000) }
    }
}

async function runCli(command, usage, argv = process.argv.slice(2)) {
    if (argv.length === 0 || argv.includes('--help')) {
        process.stderr.write(usage)
        process.exitCode = argv.length === 0 ? 1 : 0
        return
    }
    try {
        const { output, exitCode } = await command(argv)
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
        process.exitCode = exitCode
    } catch (err) {
        process.stderr.write(JSON.stringify({ ok: false, error: err.message }) + '\n')
        process.exitCode = 1
    }
}

module.exports = {
    NON_PROD_TARGETS,
    UsageError,
    parseArgs,
    isSysId,
    checkTable,
    checkSysId,
    checkWholeNumber,
    isProduction,
    refuseSessionOverrides,
    openTarget,
    tablePath,
    readBody,
    runCli,
}
