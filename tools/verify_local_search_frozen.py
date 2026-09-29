"""发布前验证打包后的多进程、动态加速组件和 sqlite-vec。"""
import multiprocessing
import json
from pathlib import Path
import sys

def main():
    import sqlite3,sqlite_vec
    from wechat_decrypt_tool.local_search.inference import LocalInference
    from wechat_decrypt_tool.local_search.catalog import model_spec,model_dir
    root=Path(sys.argv[1]).resolve()
    spec=model_spec('bge-small-zh')
    gpu=root/'local_search_gpu/cuda12.8-ort1.26.0-cudnn9.8.0.87/cp311'
    engine=LocalInference(gpu_root=gpu)
    try:
        for device in ['cpu','cuda']:
            vector=engine.encode(model_dir(root/'models',spec['id']),spec,['本地打包检索验证'],device)
            print(json.dumps({'requested':device,**engine.status,'dimension':len(vector[0])},ensure_ascii=False),flush=True)
            assert engine.status['actual_device']==device
        db=sqlite3.connect(':memory:');db.enable_load_extension(True);sqlite_vec.load(db)
        print('sqlite_vec='+db.execute('select vec_version()').fetchone()[0],flush=True)
    finally:engine.close()

if __name__=='__main__':
    multiprocessing.freeze_support()
    main()
