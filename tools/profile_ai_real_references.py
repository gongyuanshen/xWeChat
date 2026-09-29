"""用真实已保存原文对照人物检索快路径；只输出耗时、数量与引用摘要哈希。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time


def legacy_match(text, name):
    if len(name) < 2:
        return False
    edge = r'[A-Za-z0-9_]'
    pattern = (rf'(?<!{edge})' if re.match(edge, name[0]) else '') + re.escape(name)
    pattern += rf'(?!{edge})' if re.match(edge, name[-1]) else ''
    return re.search(pattern, text) is not None


def main(args):
    from wechat_decrypt_tool.ai import agent_references as module
    from wechat_decrypt_tool.ai.agent_tools import ChatTools
    database = args.data_dir / 'output/ai/ai.sqlite3'
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        run = json.loads(db.execute("SELECT body FROM records WHERE kind='agent_run' AND id=?", (args.run,)).fetchone()[0])
        messages = [json.loads(body) for body, in db.execute(
            'SELECT body FROM agent_material WHERE run_id=? ORDER BY time,source LIMIT ?', (args.run, args.limit))]
        directories = [json.loads(body) for body, in db.execute(
            "SELECT body FROM agent_piece WHERE run_id=? AND version=? AND kind='person_directory'",
            (args.run, run['version']))]
    if run['account'] == 'wxid_ai_acceptance' or not messages:
        raise ValueError('必须使用已保存的真实账号原文')
    contacts = ChatTools().people_directory(run['account']) + [person for directory in directories for person in directory]
    fast = module.contains_person_name
    rows = []
    for label, function in [('literal_fast_path', fast), ('legacy_regex', legacy_match)]:
        module.contains_person_name = function
        started = time.perf_counter()
        try:
            refs = module.material_references(run['account'], messages, contacts)
        finally:
            module.contains_person_name = fast
        row = {'mode': label, 'seconds': round(time.perf_counter() - started, 4), 'references': len(refs),
               'sha256': hashlib.sha256(json.dumps(refs, ensure_ascii=False, sort_keys=True).encode()).hexdigest()}
        rows.append(row)
        print(json.dumps(row), flush=True)
    result = {'data': 'existing_real_account', 'run_id': args.run, 'messages': len(messages),
              'contacts': len(contacts), 'remote_model_calls': 0, 'comparison': rows,
              'same_references': rows[0]['sha256'] == rows[1]['sha256']}
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    if not result['same_references']:
        raise AssertionError('新旧人物引用不一致')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--limit', type=int, default=263)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.limit < 1:
        parser.error('输出必须为新文件，数量必须为正数')
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(args.data_dir.resolve())
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(args.data_dir.resolve() / 'output')
    main(args)
