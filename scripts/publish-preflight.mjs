#!/usr/bin/env node
/**
 * Refuse to publish source that is not on the remote.
 *
 * Every @dontcode package has shipped versions whose commits were never
 * pushed. For @dontcode/auth that turned into real data loss: 0.6.0 was
 * published from a laptop that was later wiped, and for a while the only
 * surviving copy of its source was the sourcesContent inside the published
 * sourcemaps.
 *
 * `pnpm publish` runs equivalent git checks on its own; `npm publish` runs
 * none. This lives in prepublishOnly so it applies to both, and so it cannot
 * be skipped by reaching for the other package manager out of habit.
 *
 * Escape hatch (emergencies only): DONTCODE_UNSAFE_PUBLISH=1
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PUBLISH_BRANCH = 'main'

function git(...args) {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function fail(problem, fix) {
    console.error(`\n  publish blocked: ${problem}`)
    console.error(`  ${fix}\n`)
    process.exit(1)
}

if (process.env.DONTCODE_UNSAFE_PUBLISH === '1') {
    console.warn('\n  !! DONTCODE_UNSAFE_PUBLISH=1 — skipping the unpushed-source checks.')
    console.warn('  !! If this publish is not reproducible from the remote, nothing is.\n')
    process.exit(0)
}

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'))

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== PUBLISH_BRANCH) {
    fail(`on branch "${branch}", not "${PUBLISH_BRANCH}"`, `Switch to ${PUBLISH_BRANCH} first.`)
}

const dirty = git('status', '--porcelain')
if (dirty) {
    fail(
        `the working tree has uncommitted changes:\n\n${dirty}`,
        'Commit them, so what ships matches what is in git.'
    )
}

// A publish is only reproducible if the exact commit is on the remote, so
// check against a freshly fetched ref rather than a stale local one.
try {
    git('fetch', 'origin', PUBLISH_BRANCH, '--quiet')
} catch {
    fail('could not reach origin to verify the commit is pushed', 'Check your network, then retry.')
}

const head = git('rev-parse', 'HEAD')
try {
    git('merge-base', '--is-ancestor', head, `origin/${PUBLISH_BRANCH}`)
} catch {
    const unpushed = git('log', '--oneline', `origin/${PUBLISH_BRANCH}..HEAD`)
    fail(
        `HEAD (${head.slice(0, 8)}) is not on origin/${PUBLISH_BRANCH}. Unpushed:\n\n${unpushed}`,
        `Run: git push origin ${PUBLISH_BRANCH}`
    )
}

console.log(`  publish preflight ok: ${name}@${version} at ${head.slice(0, 8)} is on origin.`)
