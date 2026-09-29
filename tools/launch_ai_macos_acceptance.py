"""通过 macOS 图形登录会话启动独立验收，不从 SSH 会话直接启动原生 broker。"""
import argparse
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['electron', 'model', 'backend'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--python', default=sys.executable)
    parser.add_argument('--node', default='node')
    parser.add_argument('--playwright')
    parser.add_argument('--existing-run', help='仅重放既有真实回答的界面，不新增模型调用')
    parser.add_argument('--continuous', action='store_true', help='真实长报告、停止继续、SSE 重连和窗口恢复')
    parser.add_argument('--scroll-only', action='store_true', help='只诊断既有对话实际滚动区，不调用模型')
    parser.add_argument('--resume', action='store_true', help='通过界面继续已中断的既有长报告，不重新创建任务')
    parser.add_argument('--followup', action='store_true', help='通过既有真实回答的界面追问并复用已读资料')
    parser.add_argument('--images', action='store_true', help='真实图片问答与当前回答图片查看器')
    parser.add_argument('--manual-ime', action='store_true', help='在真实窗口等待人工系统拼音输入；不伪造组合事件')
    parser.add_argument('--max-output', type=int, help='通过设置页临时设置最大输出，结束后恢复自动识别')
    parser.add_argument('--port', type=int, default=10492)
    parser.add_argument('--static-ui', action='store_true')
    parser.add_argument('--fixture', help='本机明确标注的组件验收页面，可选')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('此启动器只用于 macOS 图形会话')
    if not 1024 <= args.port <= 65535:
        parser.error('无效端口')
    root = Path(__file__).resolve().parents[1]
    data, output = args.data.resolve(), args.output.resolve()
    if not (data / 'output/databases/wxid_ai_acceptance').is_dir():
        parser.error('请先在独立 data 目录生成验收样例')
    node = shutil.which(args.node)
    if not node:
        parser.error('找不到 Node.js')
    # 保留虚拟环境路径；解析 Python 符号链接会意外指向全局解释器。
    python = Path(os.path.abspath(args.python))
    if not python.is_file():
        parser.error('找不到指定 Python')
    output.mkdir(parents=True, exist_ok=False)
    app = output / 'AI-Acceptance.app'
    executable = app / 'Contents/MacOS/run'
    executable.parent.mkdir(parents=True)
    with (app / 'Contents/Info.plist').open('wb') as stream:
        plistlib.dump({'CFBundleIdentifier': 'local.wechatdataanalysis.acceptance',
            'CFBundleName': 'AI Acceptance', 'CFBundleExecutable': 'run',
            'CFBundlePackageType': 'APPL', 'LSBackgroundOnly': True}, stream)
    if args.mode in ('electron', 'model'):
        script = 'verify_ai_model_electron.cjs' if args.mode == 'model' else 'verify_ai_electron.cjs'
        command = [node, str(root / 'tools' / script), '--data', str(data),
                   '--output', str(output / 'result'), '--port', str(args.port)]
        if args.playwright:
            command += ['--playwright', args.playwright]
        if args.existing_run and args.mode == 'model':
            command += ['--existing-run', args.existing_run]
        if args.continuous and args.mode == 'model':
            command.append('--continuous')
        if args.scroll_only and args.mode == 'model':
            command.append('--scroll-only')
        if args.resume and args.mode == 'model':
            command.append('--resume')
        if args.followup and args.mode == 'model':
            command.append('--followup')
        if args.images and args.mode == 'model':
            command.append('--images')
        if args.manual_ime and args.mode == 'model':
            command.append('--manual-ime')
        if args.max_output is not None and args.mode == 'model':
            command += ['--max-output', str(args.max_output)]
        if args.static_ui and args.mode == 'electron':
            command.append('--static-ui')
        if args.fixture and args.mode == 'electron':
            command += ['--fixture', args.fixture]
    else:
        command = [node, str(root / 'tools/start_ai_acceptance.cjs'), '--data', str(data),
                   '--python', str(python), '--port', str(args.port)]
    # 只传递运行所需路径，不复制 SSH 密码或模型 API 配置。
    runtime_path = os.pathsep.join(dict.fromkeys([str(Path(node).parent),
        str(Path.home() / '.local/bin'), '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']))
    credentials = ''
    if args.mode == 'model' and not args.existing_run:
        # FIFO 只传递输入，不把密钥内容写入磁盘；实际模型配置仍由设置页保存。
        pipe = output / 'credentials.pipe'
        os.mkfifo(pipe, 0o600)
        credentials = ' < ' + shlex.quote(str(pipe))
    lines = ['#!/bin/bash', 'export PATH=' + shlex.quote(runtime_path),
             'export UV_PROJECT_ENVIRONMENT=' + shlex.quote(str(python.parent.parent)),
             'cd ' + shlex.quote(str(root)),
             'exec ' + shlex.join(command) + credentials + ' > ' + shlex.quote(str(output / 'launch.log')) + ' 2>&1']
    executable.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    executable.chmod(0o755)
    subprocess.run(['/usr/bin/open', '-n', '-a', str(app)], check=True)
    print(f'已提交图形会话启动：{output}；请核对结果文件，启动成功不等于验收通过。')


if __name__ == '__main__':
    main()
