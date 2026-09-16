// One command that runs every offline suite and prints one verdict.
//
// The suites are separate files because they test separate things (the policy,
// the files, the adapter, the artifact, the page) and a failure should point at
// one of them. This runner is only about not having to remember the list.
import { spawnSync } from 'node:child_process'

const SUITES = [
  ['test-model-routing-config.mjs', '策略核心：校验、判定阶梯、轮转'],
  ['test-store.mjs', '配置文件：真实文件系统的读写'],
  ['test-router-host.mjs', '适配层：路由接缝、委派工具、健康面'],
  ['test-store-wiring.mjs', '接线：构建产物读真实配置目录'],
  ['test-package.mjs', '包：两个真实加载器 + skill 契约'],
  ['test-render.mjs', '设置页：真实 React 渲染'],
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
  })
  if (!ok) {
    // Only the failing suite's output is echoed: a wall of green hides the reason.
    console.log(output.split('\n').filter(line => /FAIL|Error|error:/.test(line)).slice(0, 12).join('\n'))
  }
}

for (const row of rows) {
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.result.padEnd(14)} ${row.label}`)
}
console.log(`\n${rows.length - failed}/${rows.length} suites passed`)
process.exit(failed > 0 ? 1 : 0)
