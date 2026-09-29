"""在 macOS / Windows 检查 AI 依赖、媒体、检查点及可选的真实 CPU 推理。"""
import argparse
import json
import multiprocessing

if __name__ == '__main__':
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-root', help='应用检索模型目录；提供后执行 BGE Small 真实子进程推理')
    args = parser.parse_args()
    from wechat_decrypt_tool.ai.runtime_check import check_runtime
    print(json.dumps(check_runtime(args.model_root), ensure_ascii=False))
