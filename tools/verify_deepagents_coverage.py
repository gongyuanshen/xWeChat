"""独立读取聊天导出游标，核对 DeepAgents 原文身份、日期统计和发言人统计。"""
import argparse
from collections import Counter
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import sqlite3


def main(args):
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(args.data.resolve())
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(args.data.resolve() / 'output')
    os.environ['WCE_NATIVE_CORE_SOURCE_DIR'] = str(args.native_core_dir.resolve())
    from wechat_decrypt_tool.native_core_client import configure_native_core_entrypoint
    configure_native_core_entrypoint()
    from wechat_decrypt_tool import chat_export_service as export
    with sqlite3.connect(args.state / 'ai.sqlite3') as db:
        run = json.loads(db.execute("SELECT body FROM records WHERE kind='agent_run' AND id=?", (args.run,)).fetchone()[0])
        actual = [json.loads(r[0]) for r in db.execute('SELECT body FROM agent_material WHERE run_id=?', (args.run,))]
    interval = run['time_range']
    account_dir = export._resolve_account_dir(run['account'])
    connection = export.WCDB_REALTIME.ensure_connected(account_dir)
    original = []
    for username in run['query_scope']:
        original.extend((username, row) for row in export._iter_realtime_rows_for_conversation(
            rt_conn=connection, account_dir=account_dir, conv_username=username,
            start_time=interval['start'], end_time=interval['end'] - 1))
    expected_ids = {(u, f'{r.db_stem}:{r.table_name}:{r.local_id}') for u, r in original}
    actual_ids = {(m['username'], m['anchor']) for m in actual}
    zone = timezone(timedelta(seconds=run['timezone_offset']))
    day = lambda stamp: datetime.fromtimestamp(stamp, zone).strftime('%Y-%m-%d')
    expected_days = Counter(day(r.create_time) for _, r in original)
    actual_days = Counter(day(m['time']) for m in actual)
    # 导出消息解析器从群 XML/正文中还原发送者；直接计 raw row 会漏掉这些消息。
    expected_senders = Counter(export._parse_message_for_export(row=r, conv_username=u,
        is_group=u.endswith('@chatroom'), resource_conn=None, resource_chat_id=None).get('senderUsername')
        or r.sender_username for u, r in original)
    actual_senders = Counter(m.get('sender_id') or m.get('media', {}).get('senderUsername') or m['sender'] for m in actual)
    checks = {'unique_originals': len(expected_ids) == len(original), 'identical_messages': expected_ids == actual_ids,
        'identical_total': len(actual) == len(original), 'identical_daily_counts': expected_days == actual_days,
        'identical_sender_counts': expected_senders == actual_senders,
        'range': all(interval['start'] <= r.create_time < interval['end'] for _, r in original),
        'program_complete': run.get('coverage_state') == 'complete'}
    report = {'passed': all(checks.values()), 'checks': checks, 'baseline_reader': 'chat_export_native_cursor',
        'run_id': args.run, 'model_calls': 0, 'total': len(original), 'daily': dict(expected_days),
        'sender_counts': dict(expected_senders), 'missing': sorted(expected_ids - actual_ids), 'extra': sorted(actual_ids - expected_ids)}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: report[k] for k in ('passed', 'checks', 'total')}, ensure_ascii=False))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=Path(os.environ['APPDATA']) / 'wechat-data-analysis-desktop')
    parser.add_argument('--native-core-dir', type=Path, required=True)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--output', type=Path, required=True)
    raise SystemExit(main(parser.parse_args()))
