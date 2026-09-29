// Windows 原生界面验收使用：同源转发静态页面和 API，按命令只中断 SSE。
const { parseArgs } = require('node:util')
const fs = require('node:fs/promises')
const readline = require('node:readline')
const { createStreamProxy } = require('./ai_acceptance_stream_proxy.cjs')
const { values } = parseArgs({ options: { backend: { type:'string' }, port: { type:'string' }, output: { type:'string' } } })
async function main() {
  if (!values.backend || !values.output) throw new Error('需要本机后端与新的证据文件')
  try { await fs.access(values.output); throw new Error('证据文件已存在') } catch (e) { if (e.code !== 'ENOENT') throw e }
  const proxy = await createStreamProxy(values.backend, { passthrough:true, port:Number(values.port || 0) })
  const actions = []
  const save = async () => {
    const snapshot = { url:proxy.url, actions, connections:proxy.requests, images:proxy.images }
    await fs.writeFile(values.output, JSON.stringify(snapshot,null,2))
    console.log(JSON.stringify({ url:proxy.url, connections:proxy.requests.length, latest:proxy.requests.at(-1), action:actions.at(-1) }))
  }
  await save()
  const input = readline.createInterface({ input:process.stdin })
  try {
    for await (const command of input) {
      if (command === 'drop') proxy.drop()
      else if (command === 'resume') proxy.resume()
      else if (/^(missing|restore) [a-f0-9]{32}$/.test(command)) {
        const [operation, md5] = command.split(' ')
        proxy.setMissingImage(md5, operation === 'missing')
      }
      else if (command !== 'status' && command !== 'close') { console.log('支持 drop / resume / missing MD5 / restore MD5 / status / close'); continue }
      actions.push({ command, at:Date.now() })
      await save()
      if (command === 'close') break
    }
  } finally {
    // 终端退出也释放监听端口，避免留下无法再接收控制命令的代理。
    await save()
    await proxy.close()
    input.close()
  }
}
main().catch(e => { console.error(e.message); process.exitCode=1 })
