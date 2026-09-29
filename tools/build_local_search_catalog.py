"""发布工具：从固定 Hugging Face 提交生成文件白名单和校验清单。"""
import hashlib
import json
from pathlib import Path
import httpx

MODELS = [
    ('bge-small-zh', 'BGE Small 中文', 'Xenova/bge-small-zh-v1.5', '75c43b069aac4d136ba6bc1122f995fedcfd2781', 512, 'cls', '为这个句子生成表示以用于检索相关文章：'),
    ('bge-base-zh', 'BGE Base 中文', 'Xenova/bge-base-zh-v1.5', '71e50dc531959f9e04ebf190ea25b00261a0a186', 768, 'cls', '为这个句子生成表示以用于检索相关文章：'),
    ('e5-small', 'Multilingual E5 Small', 'intfloat/multilingual-e5-small', '614241f622f53c4eeff9890bdc4f31cfecc418b3', 384, 'mean', 'query: '),
]

def main():
    catalog = []
    with httpx.Client(follow_redirects=True, timeout=60) as client:
        for id, name, repo, revision, dimension, pooling, prefix in MODELS:
            response = client.get(f'https://huggingface.co/api/models/{repo}/revision/{revision}', params={'blobs': 'true'})
            response.raise_for_status()
            files = []
            for entry in response.json()['siblings']:
                path = entry['rfilename']
                if path not in {'onnx/model.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json', 'special_tokens_map.json', 'vocab.txt', 'sentencepiece.bpe.model'} and not path.startswith('onnx/model.onnx_data'):
                    continue
                lfs = entry.get('lfs') or {}
                digest = lfs.get('sha256')
                size = entry.get('size') or lfs.get('size')
                if not digest:
                    content = client.get(f'https://huggingface.co/{repo}/resolve/{revision}/{path}')
                    content.raise_for_status()
                    digest, size = hashlib.sha256(content.content).hexdigest(), len(content.content)
                files.append({'path': path, 'size': size, 'sha256': digest})
            assert {'tokenizer.json', 'onnx/model.onnx'}.issubset({f['path'] for f in files})
            catalog.append(dict(id=id, name=name, repo=repo, revision=revision, dimension=dimension,
                pooling=pooling, query_prefix=prefix, passage_prefix='passage: ' if id == 'e5-small' else '',
                max_tokens=512, license='MIT', recommended=id == 'bge-small-zh', files=files,
                description={'bge-small-zh': '轻量中文，适合低配置电脑', 'bge-base-zh': '中文进阶，资源占用更高', 'e5-small': '适合中英文及多语言聊天'}[id]))
    target = Path(__file__).resolve().parents[1] / 'src/wechat_decrypt_tool/resources/local_search_models.json'
    target.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print([(m['id'], len(m['files']), sum(f['size'] for f in m['files'])) for m in catalog])

if __name__ == '__main__':
    main()
