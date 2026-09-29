"""真实匿名下载与 CPU 加载验收，不访问聊天记录或线上模型。"""
import asyncio
import json
from pathlib import Path
import time
from wechat_decrypt_tool.local_search.service import LocalSearch

async def main():
    root = Path(__file__).resolve().parents[1] / 'tmp/local-search-validation'
    service = LocalSearch(root=root / 'state', model_root=root / 'models')
    try:
        for id in ('bge-small-zh', 'bge-base-zh', 'e5-small'):
            started = time.time()
            await service.downloads.start(id)
            while not service.downloads.tasks[id].done():
                await asyncio.sleep(5)
                job = service.store.get('download', id)
                print(json.dumps({k:job.get(k) for k in ('id','status','stage','bytes','total','attempt','error')},ensure_ascii=False),flush=True)
            print(json.dumps({'model':id,'seconds':time.time()-started,'available':service.downloads.available(id)},ensure_ascii=False),flush=True)
    finally:
        await service.stop()

if __name__ == '__main__': asyncio.run(main())
