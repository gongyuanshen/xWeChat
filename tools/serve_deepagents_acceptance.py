"""启动隔离 AI 任务库与正式 HTTP 界面，复用现有账号和内存中的模型密钥。"""
import argparse
import json
import os
from pathlib import Path
import sqlite3


def main(args):
    data = args.data.resolve()
    os.environ.update(WECHAT_TOOL_DATA_DIR=str(data), WECHAT_TOOL_OUTPUT_DIR=str(data / 'output'),
        WCE_NATIVE_CORE_SOURCE_DIR=str(args.native_core_dir.resolve()), WECHAT_TOOL_UI_DIR=str(args.ui.resolve()))
    from wechat_decrypt_tool.ai.storage import AIStore
    from wechat_decrypt_tool.ai.providers import ModelService, public_profile
    from wechat_decrypt_tool.ai import service as ai_module
    from wechat_decrypt_tool.ai import agent_service as agent_module
    with sqlite3.connect((data / 'output/ai/ai.sqlite3').as_uri() + '?mode=ro', uri=True) as db:
        defaults = json.loads(db.execute("SELECT body FROM records WHERE kind='defaults' AND id='global'").fetchone()[0])
        profile = json.loads(db.execute("SELECT body FROM records WHERE kind='profile' AND id=?", (defaults['text'],)).fetchone()[0])
    store = AIStore(args.state.resolve())
    store.put('profile', public_profile(profile), id=profile['id'])
    store.put('defaults', {'text': profile['id']}, id='global')
    models = ModelService(store)
    original = models.resolve
    def resolve(*values, **kwargs):
        result = original(*values, **kwargs)
        if result['id'] == profile['id']:
            result['api_key'] = profile.get('api_key', '')
        return result
    models.resolve = resolve
    ai_module._service = ai_module.AIService(store, models)
    agent_module._agent = agent_module.AgentService(ai_module._service)
    import uvicorn
    from wechat_decrypt_tool.api import app
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=Path(os.environ['APPDATA']) / 'wechat-data-analysis-desktop')
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--native-core-dir', type=Path, required=True)
    parser.add_argument('--ui', type=Path, default=Path('frontend/.output/public'))
    parser.add_argument('--port', type=int, default=10592)
    main(parser.parse_args())
