"""隔离样例库 + 真实 CPU 检索模型：验证批次发布、边建边查、暂停重启和增量。"""
import argparse
import asyncio
import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path


async def verify(output, model_root):
    from seed_ai_acceptance import seed
    from wechat_decrypt_tool.local_search.service import LocalSearch
    from wechat_decrypt_tool.local_search.catalog import model_dir, model_spec, verify_model
    account = 'wxid_ai_acceptance'
    seed(output / 'output')
    root = output / 'output/databases' / account
    with sqlite3.connect(root / 'message_0.db') as db:
        for (table,) in db.execute("SELECT name FROM sqlite_master WHERE name LIKE 'msg_%'").fetchall():
            db.execute(f'UPDATE "{table}" SET create_time=create_time-40*86400 WHERE local_id<=5')
    report = {'remote_api_calls':0, 'data':'synthetic_sqlite', 'device':'cpu', 'local_encode_batches':0}
    def service():
        local = LocalSearch(output / 'index', model_root=model_root)
        encode = local.engine.encode
        def counted(*args, **kwargs):
            report['local_encode_batches'] += 1
            return encode(*args, **kwargs)
        local.engine.encode = counted
        return local
    local = service()
    try:
        spec = model_spec('bge-small-zh')
        verify_model(model_dir(model_root,spec['id']),spec)
        # 模型文件只读；将校验成功的版本登记到独立验收状态库。
        local.store.put('model',{'id':spec['id'],'revision':spec['revision']},id=spec['id'])
        await local.configure(account, {'enabled':True, 'model':'bge-small-zh', 'device':'cpu', 'read_batch_size':16})
        job = await local.ensure_global(account)
        for _ in range(3000):
            active = local.config(account).get('active')
            if active: break
            if local.jobs[job['id']].done(): raise AssertionError(local.store.get('index_job',job['id']))
            await asyncio.sleep(.02)
        else: raise TimeoutError('首批索引未发布')
        assert active['partial'] is True
        query = asyncio.create_task(local.hybrid(account, {'hits':[]}, '报价', local.config(account)['usernames']))
        await asyncio.sleep(0)
        await local.pause_account(account)
        found = await query
        assert found['retrievalMode'] == 'hybrid' and found['coverage']['partial']
        paused = local.store.get('index_job',job['id'])
        assert paused['status'] == 'paused', paused['status']
        committed = local.index(account).stats(job['generation'])['messages']
        assert 0 < committed < 117
        report.update(partial_query_hits=len(found['hits']), committed_at_pause=committed, paused=True)
        await local.stop()
        local = service()
        resumed = await local.resume(account,job['id'])
        await local.jobs[job['id']]
        assert resumed['status'] == 'done', resumed.get('error')
        assert resumed['index_stats']['messages'] == 117
        assert local.config(account)['active']['partial'] is False
        report['resumed_messages'] = resumed['index_stats']['messages']
        table = 'msg_' + hashlib.md5(b'acceptance_friend').hexdigest()
        with sqlite3.connect(root / 'message_0.db') as db:
            db.execute(f'INSERT INTO "{table}" VALUES(?,?,?,?,?,?,?,?)', (999,999999,1,999,1,int(time.time()),'增量验收：补充报价 16800 元。',None))
        # 第一批增量提交后，立即查询另一个会话的更早历史；不能只检查最终消息总数。
        published = asyncio.Event()
        publish_partial = local.publish_partial
        def observe_partial(current):
            publish_partial(current)
            if current.get('incremental'):
                published.set()
        local.publish_partial = observe_partial
        updated = await local.build(account)
        await asyncio.wait_for(published.wait(), 60)
        assert not local.jobs[updated['id']].done(), '必须在增量仍运行时发起查询'
        other = next(u for u in updated['config']['usernames'] if u != updated['segments'][0]['username'])
        old_end = int(time.time()) - 30 * 86400
        retained = await local.hybrid(account, {'hits': []}, '交付', [other], end=old_end)
        assert retained['retrievalMode'] == 'hybrid' and retained['hits']
        assert all(h['username'] == other and h['createTime'] <= old_end for h in retained['hits'])
        report['older_chat_query_during_incremental'] = {'hits': len(retained['hits']), 'partial': retained['coverage']['partial']}
        await local.jobs[updated['id']]
        assert updated['status'] == 'done', updated.get('error')
        assert updated['index_stats']['messages'] == 118
        assert updated['generation'] == job['generation']
        active = local.config(account)['active']
        assert active['partial'] is False
        for username in updated['config']['usernames']:
            assert any(r['username'] == username and r['complete'] and r['start'] == 0 and r['end'] == updated['end']
                       for r in active['coverage'].values()), '增量结束后历史覆盖记录丢失'
        report['full_coverage_preserved_after_incremental'] = True
        matched = await local.hybrid(account, {'hits':[]}, '补充报价', ['acceptance_friend'])
        assert any('16800' in hit['content'] for hit in matched['hits'])
        isolated = await local.hybrid('another-account', {'hits':[]}, '报价', ['acceptance_friend'])
        assert isolated['retrievalMode'] == 'keyword' and not isolated['hits']
        report.update(incremental_messages=118, incremental_embedded=updated['embedded'], account_isolation=True, passed=True)
    finally:
        await local.stop()
        (output / 'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--model-root',type=Path,required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True,exist_ok=False)
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(output)
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(output / 'output')
    asyncio.run(verify(output,args.model_root.resolve()))
