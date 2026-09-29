"""真实 HF 下载暂停、进程退出恢复和离线导入验收。"""
import asyncio
import json
from pathlib import Path
import time
from wechat_decrypt_tool.local_search.service import LocalSearch
from wechat_decrypt_tool.local_search.catalog import model_dir,model_spec

async def main():
    root=Path(__file__).resolve().parents[1]/'tmp/local-search-validation'
    test=root/f'recovery-{int(time.time())}'
    service=LocalSearch(test/'state',test/'models')
    spec=model_spec('bge-small-zh')
    try:
        job=await service.downloads.start(spec['id'])
        deadline=time.monotonic()+120
        while job['bytes']<5_000_000 and time.monotonic()<deadline:
            if job['status']=='error': raise RuntimeError(job['error'])
            await asyncio.sleep(.1)
        await service.downloads.pause(spec['id'])
        assert job['status']=='paused'
        partial=sum(p.stat().st_size for p in model_dir(test/'models',spec['id']).rglob('*.incomplete'))
        await service.stop()
        service=LocalSearch(test/'state',test/'models')
        await service.start()
        assert service.store.get('download',spec['id'])['status']=='paused'
        resumed=await service.downloads.start(spec['id']);await service.downloads.tasks[spec['id']]
        assert resumed['status']=='done',resumed
        await service.stop()
        imported=LocalSearch(test/'import-state',test/'import-models')
        try:
            result=await imported.downloads.import_model(spec['id'],model_dir(test/'models',spec['id']))
            await imported.downloads.tasks[spec['id']]
            assert result['status']=='done',result
            assert imported.downloads.available(spec['id'])
        finally:await imported.stop()
        record={'paused_bytes':job['bytes'],'retained_partial_bytes':partial,'restart_preserved_pause':True,
                'resume_verified':True,'offline_import_verified':True,'root':str(test)}
        print(json.dumps(record,ensure_ascii=False),flush=True)
        (root/'recovery-results.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
    finally:await service.stop()

if __name__=='__main__':asyncio.run(main())
