"""只读记录 AI 补充、停止和继续的持久化状态；不输出密钥或完整配置。"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import time


def capture(database, run_id):
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.execute('BEGIN')
        row = db.execute("SELECT body FROM records WHERE kind='agent_run' AND id=?", (run_id,)).fetchone()
        if not row:
            raise ValueError('运行不存在')
        run = json.loads(row[0])
        thread = json.loads(db.execute("SELECT body FROM records WHERE kind='agent_thread' AND id=?", (run['thread_id'],)).fetchone()[0])
        materials = {source:hashlib.sha256(body.encode()).hexdigest() for source, body in db.execute(
            'SELECT source,body FROM agent_material WHERE run_id=?', (run_id,))}
        pieces = [{'id':identifier,'kind':kind,'sha256':hashlib.sha256(body.encode()).hexdigest()} for identifier,kind,body in db.execute(
            'SELECT id,kind,body FROM agent_piece WHERE run_id=? AND version=?', (run_id, run['version']))]
        usage = [json.loads(body) for body, in db.execute(
            "SELECT body FROM records WHERE kind='usage' AND account=? AND json_extract(body,'$.task_id')=?", (run['account'],run_id))]
    profile = run.get('profile') or {}
    return {**{k:run.get(k) for k in ('id','thread_id','status','stage','version','applied_version','used','time_range','read_count','note_key','query_filters')},
            'at':time.time(), 'profile':{k:profile.get(k) for k in ('id','model','revision','protocol','reasoning_effort')},
            'profile_fingerprint':hashlib.sha256(json.dumps(profile,sort_keys=True).encode()).hexdigest(),
            'materials':materials, 'pieces':pieces,
            'supplements':[m for m in thread.get('messages',[]) if m.get('run_id')==run_id and m.get('supplement')],
            'analysis':run.get('analysis'),
            'timeline':[{k:t.get(k) for k in ('id','kind','status','action','input_version','revision','text')} for t in run.get('timeline',[])],
            'usage':[{k:u.get(k) for k in ('id','model','profile_id','status','operation','started_at','finished_at')} for u in usage],
            'answer_chars':len(run.get('answer',''))}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',type=Path,required=True)
    parser.add_argument('--run-id',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.output.exists():
        parser.error('快照已存在，请使用新文件')
    result=capture(args.database,args.run_id)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:result[k] for k in ('id','status','stage','version','applied_version','read_count','profile')},ensure_ascii=False))
