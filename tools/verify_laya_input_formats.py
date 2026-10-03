"""Compare real Laya state formats on the same artificial messages and questions."""
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from verify_chat_insights_model import PEER, GROUP, SELF, sample_messages
from wechat_decrypt_tool.ai.insight_local import message_state, questions_for
from wechat_decrypt_tool.ai.insight_local_models import SPEC
from wechat_decrypt_tool.ai.laya_runtime import LayaRuntime


def main():
    runtime = LayaRuntime(ROOT / 'tmp/laya-real/models' / SPEC['id'] / SPEC['revision'])
    report = dict(synthetic_only=True, same_questions=True, cases=[])
    started = time.monotonic()
    try:
        for username in [PEER, GROUP]:
            context = []
            for message in sample_messages(username):
                item = message | {'target': username == GROUP or message['sender_id'] == PEER, 'quote_context': ''}
                def role(row):
                    return 'me' if row['sender_id'] == SELF else 'them'
                isolated = json.dumps({'message': item['text']}, ensure_ascii=False)
                reference = isolated if not context else '\n'.join([
                    'TARGET message to judge:', f'[{role(item)}]: {item["text"]}', '',
                    'Recent context before the target (oldest first):',
                    *[f'[{role(row)}]: {row["text"]}' for row in context]])
                states = dict(current=message_state(item, context, private_chat=username == PEER),
                    upstream_roles=reference, isolated=isolated)
                questions = questions_for(item | {'target': False}, allow_affinity=False, allow_mbti=False)
                results = {key: runtime.predict(state, questions) for key, state in states.items()}
                report['cases'].append(dict(chat=username, source=item['source'], text=item['text'],
                    states=states, answers=results))
                print(json.dumps({'text': item['text'], 'intents': {key: value['intent']['choice'] for key, value in results.items()}}, ensure_ascii=False), flush=True)
                context = (context + [item])[-3:]
    finally:
        runtime.close()
    report['seconds'] = round(time.monotonic() - started, 3)
    output = ROOT / 'tmp/laya-real/input-format-comparison.json'
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    print(str(output), flush=True)


if __name__ == '__main__':
    main()
