// 只启动隔离后端，不创建 Electron 窗口、不操作用户桌面，也不配置真实模型。
const path = require('node:path')
const { spawn } = require('node:child_process')
const { parseArgs } = require('node:util')
const { ensureSourceNativeCore, applySourceRuntimeEnvironment } = require('../desktop/src/source-native-core-bootstrap.cjs')
const { values } = parseArgs({options:{data:{type:'string'},python:{type:'string'},port:{type:'string',default:'10492'}}})
if (!values.data || !values.python) throw new Error('请传入 --data 独立验收目录和 --python Python 路径')
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('无效端口')
const root = path.resolve(__dirname, '..')
const env = {...process.env, WECHAT_TOOL_DATA_DIR:path.resolve(values.data), WECHAT_TOOL_OUTPUT_DIR:path.resolve(values.data,'output'), WECHAT_TOOL_HOST:'127.0.0.1', WECHAT_TOOL_PORT:String(port), PYTHONIOENCODING:'utf-8'}
delete env.WECHAT_TOOL_DESKTOP_PARENT_PID
applySourceRuntimeEnvironment(env, ensureSourceNativeCore({env}))
const child = spawn(path.resolve(values.python), ['main.py'], {cwd:root,env,stdio:'inherit',windowsHide:true})
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill())
child.on('error',error=>{console.error(error.message);process.exitCode=1})
child.on('exit',code=>{process.exitCode=code || 0})
