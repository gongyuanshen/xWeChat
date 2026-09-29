"""实机 NVIDIA 验收，仅使用固定测试句子，不读取账号聊天。"""
import asyncio
import json
from pathlib import Path
import time
from wechat_decrypt_tool.local_search.service import LocalSearch
from wechat_decrypt_tool.local_search.catalog import model_dir,model_spec

async def main():
    import numpy as np
    root=Path(__file__).resolve().parents[1]/'tmp/local-search-validation'
    service=LocalSearch(root=root/'state',model_root=root/'models')
    try:
        if not service.gpu.installed():
            await service.gpu.start()
            while not service.gpu.task.done():
                await asyncio.sleep(10)
                print(json.dumps(service.gpu.status()['job'],ensure_ascii=False),flush=True)
            if not service.gpu.installed(): raise RuntimeError('GPU 组件未安装完成')
        for id in ('bge-small-zh','bge-base-zh','e5-small'):
            spec=model_spec(id); path=model_dir(service.downloads.root,id)
            texts=['这周来不及了，下周二交付。','周末一起去吃饭。','项目会延期吗？']
            cpu=await asyncio.to_thread(service.engine.encode,path,spec,texts,'cpu')
            started=time.monotonic()
            gpu=await asyncio.to_thread(service.engine.encode,path,spec,texts,'cuda')
            print(json.dumps({'model':id,'device':service.engine.status,'max_error':float(np.abs(np.array(cpu)-np.array(gpu)).max()),'seconds':time.monotonic()-started},ensure_ascii=False),flush=True)
    finally: await service.stop()

if __name__=='__main__':asyncio.run(main())
