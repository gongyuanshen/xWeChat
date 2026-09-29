"""仅在停止的运行中，从同一真实原库恢复被聊天页格式覆盖的原文字段。"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sqlite3


async def main(args):
    from wechat_decrypt_tool.native_core_client import configure_native_core_entrypoint
    configure_native_core_entrypoint()
    from wechat_decrypt_tool.ai.agent_tools import ChatTools
    report = json.loads(args.verification.read_text(encoding='utf-8'))
    if report['account'] != args.account or report['run_id'] != args.run or report['expected_source'] != 'realtime_original_metadata':
        raise ValueError('必须使用同账号、同运行的实时原库核对结果')
    database = args.data_dir / 'output/ai/ai.sqlite3'
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        run = json.loads(db.execute("SELECT body FROM records WHERE kind='agent_run' AND id=?", (args.run,)).fetchone()[0])
        if run['account'] != args.account or run['status'] not in ('cancelled', 'interrupted', 'failed'):
            raise ValueError('只能修复已停止且账号一致的运行')
        originals = {source: db.execute('SELECT body FROM agent_material WHERE run_id=? AND source=?',
                                       (args.run, source)).fetchone()[0] for source in report['incomplete_sources']}
    changes = []
    tools = ChatTools()
    for source, body in originals.items():
        old = json.loads(body)
        state, canonical = None, None
        while True:
            page = await tools.time_window(args.account, old['username'], old['time'], old['time'] + 1,
                                           1048576, state=state, checkpoint=lambda: None)
            if page.get('warning') or page.get('data_source') != 'realtime':
                raise ValueError('恢复必须直接读取实时原库，不能从不完整或回退数据重建')
            canonical = next((m for m in page['originals'] if m['source'] == source and m['anchor'] == old['anchor']), canonical)
            if not page['has_more']:
                break
            state = page['next_state']
        if not canonical:
            raise ValueError('原库中没有同一定位与身份，停止修复')
        changes.append({'source': source, 'anchor': old['anchor'], 'old_text': old['text'],
                        'canonical_text': canonical['text'], 'old_body_sha256': hashlib.sha256(body.encode()).hexdigest()})
    audit = {'account': args.account, 'run_id': args.run, 'remote_model_calls': 0,
             'source': 'realtime_original', 'committed': False, 'changes': changes}
    args.output.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
    with sqlite3.connect(database) as db:
        db.execute('BEGIN IMMEDIATE')
        current = json.loads(db.execute("SELECT body FROM records WHERE kind='agent_run' AND id=?", (args.run,)).fetchone()[0])
        if current['status'] != run['status'] or current['version'] != run['version']:
            raise ValueError('运行状态已变化，停止修复')
        for change in changes:
            body = db.execute('SELECT body FROM agent_material WHERE run_id=? AND source=?', (args.run, change['source'])).fetchone()[0]
            if body != originals[change['source']]:
                raise ValueError('原文已被其他操作修改，停止修复')
            db.execute("UPDATE agent_material SET body=json_set(body,'$.text',?) WHERE run_id=? AND source=?",
                       (change['canonical_text'], args.run, change['source']))
    audit['committed'] = True
    args.output.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'committed': True, 'restored_originals': len(changes), 'remote_model_calls': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--native-core-dir', type=Path, required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--verification', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.output.resolve().is_relative_to(args.data_dir.resolve()):
        parser.error('修复记录须为应用数据目录外的新文件')
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(args.data_dir.resolve())
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(args.data_dir.resolve() / 'output')
    os.environ['WCE_NATIVE_CORE_SOURCE_DIR'] = str(args.native_core_dir.resolve())
    asyncio.run(main(args))
