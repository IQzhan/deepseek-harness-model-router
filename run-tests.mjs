// One command that runs every offline suite and prints one verdict.
//
// The suites are separate files because they test separate things (the policy,
// the files, the adapter, the artifact, the page) and a failure should point at
// one of them. This runner is only about not having to remember the list.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SUITES = [
  ['test-model-routing-config.mjs', '策略核心：校验、判定阶梯、轮转'],
  ['test-store.mjs', '配置文件：真实文件系统的读写'],
  ['test-router-host.mjs', '适配层：路由接缝、委派工具、健康面'],
  ['test-store-wiring.mjs', '接线：构建产物读真实配置目录'],
  ['test-package.mjs', '包：两个真实加载器 + skill 契约'],
  ['test-render.mjs', '设置页：真实 React 渲染'],
  ['test-docs.mjs', '文档：双语同步与内容守卫'],
  ['test-portability.mjs', '可移植性：无绝对路径、无平台专有构造'],
  ['test-deployed-config.mjs', '本机真实配置'],
]

const rows = []
let failed = 0
for (const [file, label] of SUITES) {
  const run = spawnSync(process.execPath, [file], { encoding: 'utf8' })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const tally = /(\d+)\/(\d+) passed/.exec(output)
  const ok = run.status === 0 && tally !== null
  if (!ok) failed += 1
  rows.push({
    file,
    label,
    ok,
    result: tally === null ? `crashed (exit ${String(run.status)})` : tally[0],
    // The count each suite reports, so the README's figures can be checked against
    // reality instead of against memory.
    asserted: tally === null ? 0 : Number(tally[2]),
  })
  if (!ok) {
    // Only the failing suite's output is echoed: a wall of green hides the reason.
    console.log(output.split('\n').filter(line => /FAIL|Error|error:/.test(line)).slice(0, 12).join('\n'))
  }
}

// The READMEs state how much is tested. That number is the one thing a structural
// comparison cannot check (both languages agree on a stale figure just fine), so it is
// checked HERE, against the run that just happened: a suite that grew without the
// documentation following fails this run.
const measured = rows.reduce((total, row) => total + row.asserted, 0)
// Captured before the documentation rows join `rows`, so the comparison is against the
// SUITES that ran rather than against the growing report.
const suiteCount = rows.length
const docs = [['README.md', /(\d+)\s*suites/], ['README.zh.md', /(\d+)\s*个套件/]]
const documented = docs.map(([file, suitePattern]) => {
  const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
  const suites = suitePattern.exec(text)
  const assertions = /(\d+)\s*(?:assertions|条断言)/u.exec(text)
  return { file, suites: suites?.[1] ?? null, assertions: assertions?.[1] ?? null }
})
for (const entry of documented) {
  const ok = Number(entry.suites) === suiteCount && Number(entry.assertions) === measured
  if (!ok) failed += 1
  rows.push({
    file: entry.file,
    label: 'the README states this run',
    ok,
    result: `${entry.suites ?? '?'} suites / ${entry.assertions ?? '?'} assertions`,
  })
}
if (documented.some(entry => Number(entry.assertions) !== measured)) {
  console.log(`\nThe run measured ${suiteCount} suites and ${measured} assertions;`
    + ' update both READMEs (both languages) to match.')
}

for (const row of rows) {
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.result.padEnd(14)} ${row.label}`)
}
console.log(`\n${rows.length - failed}/${rows.length} suites passed`)
process.exit(failed > 0 ? 1 : 0)
