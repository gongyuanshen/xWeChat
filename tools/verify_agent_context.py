"""用现有配置验收 Agent；独立保存测试记录，不复制密钥、不改用户规则。"""
import argparse
import asyncio
import json
import os
import re
from pathlib import Path
import sqlite3
import time


async def verify(args):
    os.environ['WECHAT_TOOL_DATA_DIR']=str(Path(args.data_dir).resolve())
    from wechat_decrypt_tool.ai.storage import AIStore
    from wechat_decrypt_tool.ai.providers import ModelService
    from wechat_decrypt_tool.ai.service import AIService
    from wechat_decrypt_tool.ai.agent_service import AgentService
    origin=Path(args.data_dir)/'output'/'ai'/'ai.sqlite3'
    with sqlite3.connect(origin.as_uri()+'?mode=ro',uri=True) as db:
        profiles={p['id']:p for (body,) in db.execute("SELECT body FROM records WHERE kind='profile'") for p in [json.loads(body)]}
        defaults=json.loads(db.execute("SELECT body FROM records WHERE kind='defaults' AND id='global'").fetchone()[0])
    store=AIStore(Path(args.state_dir))
    store.put('defaults',defaults,id='global')
    class ConfiguredModels(ModelService):
        def resolve(self,id='',vision=False):
            return profiles[id or defaults['vision' if vision else 'text']]
    service=AgentService(AIService(store,ConfiguredModels(store)))
    if args.refresh_answer:
        if not args.resume_run:raise ValueError('刷新回答必须指定验收任务')
        saved=service.run(args.resume_run,args.account)
        if not saved.get('analysis',{}).get('complete'):raise ValueError('仅可刷新已完成范围分析的回答')
        service.update(args.resume_run,status='interrupted',pending_actions=[{'action':'answer'}])
    thread=service.thread(service.run(args.resume_run,args.account)['thread_id'],args.account) if args.resume_run else await service.create_thread(args.account,args.username,'上下文与检索验收')
    report_path=Path(args.state_dir,'verification.json')
    report=json.loads(report_path.read_text(encoding='utf-8')) if args.resume_run and report_path.exists() else {'created_at':time.time(),'thread_id':thread['id'],'runs':[]}
    try:
        for index,question in enumerate([args.question,*args.followup]):
            run=await service.resume(args.resume_run,args.account) if index==0 and args.resume_run else await service.submit(thread['id'],args.account,{'text':question,'request_id':f'verify-{time.time_ns()}-{index}','effort':'deep'})
            worker=service.workers[run['id']]
            while not worker.done():
                await asyncio.wait({worker},timeout=20)
                current=service.public_run(run['id'],args.account)
                print(json.dumps({'run':index,'status':current['status'],'stage':current.get('stage'),'read':current.get('read_count'),'analyzed':current.get('analysis',{}).get('analyzed'),'calls':current.get('usage',{}).get('calls')},ensure_ascii=True),flush=True)
            result=service.public_run(run['id'],args.account)
            with store.connection() as db:
                raw_bytes=db.execute("SELECT coalesce(sum(length(cast(json_extract(body,'$.text') AS BLOB))),0) FROM agent_material WHERE run_id=?",(run['id'],)).fetchone()[0]
                evidence_bytes=db.execute("SELECT coalesce(sum(length(cast(json_remove(body,'$.media') AS BLOB))),0) FROM agent_material WHERE run_id=?",(run['id'],)).fetchone()[0]
            entry={k:result.get(k) for k in ('id','status','error','time_range','intent','analysis','read_count','source_count','usage','coverage_warnings','answer_context')}
            entry['raw_text_bytes']=raw_bytes
            entry['evidence_json_bytes']=evidence_bytes
            entry['question']=next((m['text'] for m in service.thread(thread['id'],args.account)['messages'] if m.get('run_id')==run['id'] and m['role']=='user'),question)
            entry['answer']=result.get('answer','')
            cited=set(re.findall(r'\[\[([^\]]+)\]\]',entry['answer']))
            entry['citation_count']=len(cited)
            entry['all_citations_resolve']=all(s in service.run(run['id'])['evidence'] for s in cited)
            existing=next((i for i,item in enumerate(report['runs']) if item['id']==entry['id']),None)
            if existing is None:report['runs'].append(entry)
            else:report['runs'][existing]=entry
            report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            if result['status']!='completed':break
    finally:
        await service.stop()
    print(json.dumps({'report':str(Path(args.state_dir,'verification.json').resolve()),'statuses':[r['status'] for r in report['runs']]},ensure_ascii=True))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--data-dir',required=True)
    parser.add_argument('--state-dir',required=True)
    parser.add_argument('--account',required=True)
    parser.add_argument('--username',required=True)
    parser.add_argument('--question',default='这几天聊了什么？整理重要事情和未确认事项，附上原文出处。')
    parser.add_argument('--followup',action='append',default=[])
    parser.add_argument('--resume-run',default='')
    parser.add_argument('--refresh-answer',action='store_true')
    asyncio.run(verify(parser.parse_args()))
