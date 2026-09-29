"""从官方 PyPI 元数据固定 Windows CUDA 组件文件和哈希。"""
import json
from pathlib import Path
import httpx

def main():
    packages = [('onnxruntime-gpu','1.26.0'), ('nvidia-cuda-runtime-cu12','12.8.90'),
                ('nvidia-cublas-cu12','12.8.4.1'), ('nvidia-cudnn-cu12','9.8.0.87'), ('nvidia-cufft-cu12','11.3.3.83')]
    files = []
    with httpx.Client(timeout=30) as client:
        for name, version in packages:
            r = client.get(f'https://pypi.org/pypi/{name}/{version}/json'); r.raise_for_status()
            for f in r.json()['urls']:
                if 'win_amd64' not in f['filename']: continue
                if not any(tag in f['filename'] for tag in ('cp311','cp312','cp313','py3-none')): continue
                files.append({'name':f['filename'],'url':f['url'],'size':f['size'],'sha256':f['digests']['sha256']})
    target = Path(__file__).resolve().parents[1] / 'src/wechat_decrypt_tool/resources/local_search_gpu.json'
    target.write_text(json.dumps({'id':'cuda12.8-ort1.26.0-cudnn9.8.0.87','platform':'win32',
        'cuda':'12.8','cudnn':'9.8.0.87','runtime':'1.26.0','minimum_windows_driver':'572.61',
        'target_families':['Ampere (RTX 30)','Ada (RTX 40)','Blackwell (RTX 50)'],
        'validated_devices':['RTX 4070 SUPER / driver 596.49 / Windows x64 / CPython 3.11'],
        'files':files},indent=2)+'\n',encoding='utf-8')
    print('GPU manifest files:',len(files))

if __name__=='__main__': main()
