"""只读比较运行中的来源响应和工作区修复，不启动任务、不调用模型。"""
import argparse
import json
from pathlib import Path
import re
import sqlite3
import sys
import time
from types import SimpleNamespace
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from wechat_decrypt_tool.ai.agent_service import AgentService
from wechat_decrypt_tool.ai.agent_workspace import Evidence


def inspect(database, endpoint):
    started = time.perf_counter()
    with urlopen(endpoint, timeout=30) as response:
        payload = response.read()
    public = json.loads(payload)
    api_seconds = time.perf_counter() - started
    uri = database.resolve().as_uri() + '?mode=ro'
    def connection():
        return sqlite3.connect(uri, uri=True)
    # 不输出模型配置，也不初始化可能写入数据的服务实例。
    with connection() as db:
        db.execute('BEGIN')
        run = json.loads(db.execute("SELECT body FROM records WHERE kind='agent_run' AND id=?", (public['id'],)).fetchone()[0])
        run['answer'] = public['answer']
        run['timeline'] = public['timeline']
        run['answer_context'] = public.get('answer_context', {})
        run['evidence'] = Evidence(SimpleNamespace(store=SimpleNamespace(connection=connection)), public['id'])
        started = time.perf_counter()
        projected = AgentService.citations(SimpleNamespace(public_source=AgentService.public_source), run)
        projected_seconds = time.perf_counter() - started
    requested = {key.lower() for key in re.findall(r'\[\[([a-f0-9]{24})\]\]', public['answer'], re.I)}
    before = {c['source'] for c in public['citations']}
    after = {c['source'] for c in projected}
    # 输出只含定位和统计，不复制原文、人物档案或模型配置。
    return {'run_id': public['id'], 'status': public['status'], 'answer_chars': len(public['answer']),
            'remote_calls_by_verifier': 0, 'native_ui_verified': False,
            'api_seconds': api_seconds, 'api_bytes': len(payload),
            'required_message_references': len(requested), 'current_citations': len(before),
            'current_missing': sorted(requested - before), 'projected_citations': len(after),
            'projected_seconds': projected_seconds, 'projected_missing': sorted(requested - after),
            'projected_passed': requested <= after,
            'runtime_fix_loaded_by_this_tool': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = inspect(args.database, args.endpoint)
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
    print(json.dumps(result, ensure_ascii=False))
    if not result['projected_passed']:
        raise SystemExit(1)
