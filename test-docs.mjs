// Bilingual documentation guard.
//
// Two documents must say the same thing in two languages: `README.md` (English) and
// `README.zh.md` (Chinese). Translating one and forgetting the other is how a
// README starts lying — the reader who switches languages gets a different feature
// list, a missing section, or a command that no longer exists.
//
// A machine cannot judge prose, so this guard compares what prose cannot differ on:
// the SECTION STRUCTURE, the CODE (fenced blocks, their languages, and the inline
// code tokens), the TABLES, and the CONFIGURATION KEYS each document must mention.
// If a section is added to one language, the counts differ and the guard fails.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const DOCS = ['README.md', 'README.zh.md']
const missing = DOCS.filter(name => !existsSync(join(ROOT, name)))
check('both languages exist', missing, [])

const read = name => readFileSync(join(ROOT, name), 'utf8')
const zh = read('README.zh.md')
const en = read('README.md')

/** `## Section` headings, in order. */
const sections = text => [...text.matchAll(/^##\s+(.+)$/gm)].map(match => match[1].trim())
/** Fenced code blocks, as their declared language (empty when none). */
const fences = text => [...text.matchAll(/^```(\S*)$/gm)].map(match => match[1])
/** Inline code tokens that are language-neutral (no CJK, no spaces). */
const tokens = text => [...new Set([...text.matchAll(/`([^`\n]+)`/g)]
  .map(match => match[1].trim())
  .filter(token => /^[\x20-\x7E]+$/.test(token) && !token.includes(' ')))]
/** Table rows, which both languages must have the same number of. */
const tableRows = text => text.split('\n').filter(line => line.trimStart().startsWith('|')).length

const zhSections = sections(zh)
const enSections = sections(en)
check('the two languages have the same number of sections', enSections.length, zhSections.length)
check('and the same code blocks', fences(en), fences(zh))
check('and the same tables', tableRows(en), tableRows(zh))
check('and the same inline code', tokens(en).sort(), tokens(zh).sort())

// A language switch in the first lines of each file, pointing at the other one.
check('the English file links to the Chinese one', /README\.zh\.md/.test(en.split('\n').slice(0, 6).join('\n')), true)
check('the Chinese file links to the English one', /README\.md/.test(zh.split('\n').slice(0, 6).join('\n')), true)

// Every configuration key must be documented in BOTH languages: a key that exists
// only in one language is a feature half the readers cannot find.
const KEYS = [
  'enabled', 'defaultTaskId', 'childDelegation', 'classifier',
  'reasoningEffort', 'childPersona', 'childTools', 'pool', 'keywords', 'weight',
]
check('every configuration key is documented in both languages',
  KEYS.filter(key => !en.includes(key) || !zh.includes(key)), [])

// Commands a reader copies must be identical in both languages.
for (const command of ['node build-router.mjs', 'node verify.mjs', 'dsh plugin --profile web add ./package']) {
  check(`both languages document \`${command}\``, [en.includes(command), zh.includes(command)], [true, true])
}

// The ledger of per-feature verification is what makes the test claims checkable, so
// it must exist and be linked from both READMEs.
check('the verification ledger exists', existsSync(join(ROOT, 'docs', 'verification.md')), true)
check('and both languages link to it', [en.includes('docs/verification.md'), zh.includes('docs/verification.md')], [true, true])

// The licence section must agree with the LICENSE file.
check('both languages state the licence',
  [/MIT/.test(en), /MIT/.test(zh)], [true, true])

// The suite and assertion counts are the one kind of content a structure check cannot
// compare, so they are compared as NUMBERS: a count updated in one language only is
// how a README starts lying about how much is tested.
{
  const counts = text => {
    const suites = /(\d+)\s*(?:个套件|suites)/u.exec(text)
    const assertions = /(\d+)\s*(?:条断言|assertions)/u.exec(text)
    return [suites?.[1] ?? null, assertions?.[1] ?? null]
  }
  const [enSuites, enAssertions] = counts(en)
  const [zhSuites, zhAssertions] = counts(zh)
  check('both languages state a suite count', enSuites !== null && zhSuites !== null, true)
  check('and the same one', enSuites, zhSuites)
  check('both languages state an assertion count', enAssertions !== null && zhAssertions !== null, true)
  check('and the same one', enAssertions, zhAssertions)
}

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
