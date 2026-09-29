"""隔离验证环境中对照原作者 BGE 权重，结果不接触聊天账号。"""
import json
import os
from pathlib import Path
import sys
import time
os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN']='1'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
os.environ['HF_HUB_DISABLE_XET']='1'
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))

def main():
    import numpy as np
    import torch
    from transformers import AutoModel,AutoTokenizer
    from huggingface_hub import HfApi,hf_hub_download
    from wechat_decrypt_tool.local_search.catalog import model_spec,model_dir
    from wechat_decrypt_tool.local_search.inference import LocalInference
    root=Path(__file__).resolve().parents[1]/'tmp/local-search-validation'
    torch.set_num_threads(2)
    engine=LocalInference()
    records=[]
    try:
        for id,repo in [('bge-small-zh','BAAI/bge-small-zh-v1.5'),('bge-base-zh','BAAI/bge-base-zh-v1.5')]:
            start=time.monotonic()
            info=HfApi(token=False).model_info(repo)
            names={f.rfilename for f in info.siblings}
            chosen={'config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','vocab.txt'}&names
            chosen.add('model.safetensors' if 'model.safetensors' in names else 'pytorch_model.bin')
            original=root/'originals'/id/info.sha
            for name in sorted(chosen): hf_hub_download(repo,name,revision=info.sha,token=False,local_dir=original)
            tokenizer=AutoTokenizer.from_pretrained(original,local_files_only=True,trust_remote_code=False)
            model=AutoModel.from_pretrained(original,local_files_only=True,trust_remote_code=False).eval()
            texts=['项目延期到下周二交付。','合同的预算是三万五千元。','明天吃火锅吗？','订单编号 AB-2026-058。']
            spec=model_spec(id);path=model_dir(root/'models',id)
            from tokenizers import Tokenizer
            local=Tokenizer.from_file(str(path/'tokenizer.json'))
            same_tokens=all(tokenizer(t)['input_ids']==local.encode(t).ids for t in texts)
            batch=tokenizer(texts,return_tensors='pt',padding=True,truncation=False)
            with torch.no_grad():
                vectors=model(**batch).last_hidden_state[:,0]
                vectors=torch.nn.functional.normalize(vectors,p=2,dim=1).numpy()
            converted=np.array(engine.encode(path,spec,texts,'cpu'))
            error=float(np.abs(converted-vectors).max())
            result={'model':id,'original_repo':repo,'original_revision':info.sha,'same_tokenization':same_tokens,
                    'max_vector_error':error,'same_ranking':bool(np.array_equal(np.argsort(-(vectors@vectors.T),axis=1),np.argsort(-(converted@converted.T),axis=1))),
                    'seconds':time.monotonic()-start}
            records.append(result);print(json.dumps(result,ensure_ascii=False),flush=True)
            assert same_tokens and error<1e-4 and result['same_ranking']
            del model
        (root/'reference-results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
    finally:engine.close()

if __name__=='__main__': main()
