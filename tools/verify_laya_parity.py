"""Verify the installed real Laya model against the immutable upstream public fixture.

No download, generated fixture, private messages, or replacement model is used.
The upstream 'long' case intentionally truncates its input; production must reject
that input, while its frozen upstream tensors are still checked against the graph.
Numerical tolerances below were fixed before running this verification.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))

import numpy as np
import onnxruntime as ort

from wechat_decrypt_tool.ai.insight_local_models import SPEC
from wechat_decrypt_tool.ai.laya_runtime import LayaContextOverflow, LayaRuntime, collate, format_answers, prepare

UPSTREAM = 'https://github.com/mizchi/laya-mlx/blob/dc3aa6b150cb861d0788fbd421cfd1303de4ed57/'
FIXTURE_URL = UPSTREAM + 'web/fixtures/parity-multilingual.json'
FIXTURE_SHA256 = '797472cc8e6d56d68860239dbe8c916c26623e96b5762b0f75b71da81cb550e1'
THRESHOLDS = {'logits': .03, 'act_logits': 3.5, 'probability': .001,
              'action_probability': .001, 'score': .001, 'noul': .001, 'confidence': .002}
POLICY = {
    'source': UPSTREAM + 'docs/ONNX_EXPORT.md',
    'upstream_float16_cpu_observed_max': {'probability': .00051, 'logits': .026, 'act_logits': 2.9,
                                        'action_probability': 0.},
    'project_tolerances': THRESHOLDS,
    'explanation': 'Fixed project acceptance tolerances informed by upstream measured errors; not provider guarantees. Token IDs/tensors/choice labels must match exactly.',
    'expected_production_rejection': {'long': 'state'},
}


def inside_tmp(value):
    path = Path(value).resolve()
    if not path.is_relative_to((ROOT / 'tmp').resolve()):
        raise ValueError('Verification input and report paths must stay inside this repository tmp directory')
    return path


def max_error(actual, expected):
    actual, expected = np.asarray(actual), np.asarray(expected)
    if actual.shape != expected.shape:
        raise ValueError(f'Tensor shape mismatch: {actual.shape} vs {expected.shape}')
    if not np.isfinite(actual).all() or not np.isfinite(expected).all():
        raise ValueError('Non-finite tensor encountered')
    return float(np.max(np.abs(actual.astype(np.float64) - expected.astype(np.float64))))


def answer_errors(actual, expected):
    if set(actual) != set(expected):
        raise ValueError('Question IDs differ from frozen upstream answers')
    errors = {key: 0. for key in THRESHOLDS if key not in {'logits', 'act_logits'}}
    mismatches = []
    def decimal_error(left, right):
        # These values are the API's four-decimal output, not raw floating logits.
        # Exact decimal subtraction prevents 0.001 becoming 0.0010000000000000009.
        return float(abs(Decimal(str(left)) - Decimal(str(right))))
    for qid, ref in expected.items():
        value = actual[qid]
        if value['type'] != ref['type']:
            raise ValueError(f'{qid}: answer type mismatch')
        if ref['type'] == 'choice' and value['choice'] != ref['choice']:
            mismatches.append(qid)
        if 'probabilities' in ref:
            if set(value['probabilities']) != set(ref['probabilities']):
                raise ValueError(f'{qid}: probability label mismatch')
            errors['probability'] = max(errors['probability'],
                max(decimal_error(value['probabilities'][key], ref['probabilities'][key]) for key in ref['probabilities']))
        if 'legend' in ref and value['legend'] != ref['legend']:
            raise ValueError(f'{qid}: score legend mismatch')
        for key in ('score', 'noul', 'confidence'):
            if key in ref:
                errors[key] = max(errors[key], decimal_error(value[key], ref[key]))
        errors['action_probability'] = max(errors['action_probability'],
            decimal_error(value['action']['act_probability'], ref['action']['act_probability']))
    return errors, mismatches


def raw_probability_error(config, internal, actual, expected):
    """Compare calibrated probabilities before the production four-decimal formatting."""
    maximum = 0.
    for row, q in enumerate(internal):
        k = len(q['crit']) if q['t'] != 'noul' else 2
        bucket = '2' if k <= 2 else '3-5' if k <= 5 else '6-10' if k <= 10 else '11+'
        qtype = {'choice': 0, 'score': 1, 'noul': 2}[q['t']]
        scale = config['temperature_by_options'].get(f"{q['t']}:{bucket}", config['temperature'][qtype])
        probabilities = []
        for logits in (actual, expected):
            z = np.asarray(logits[row][:k], dtype=np.float64) / max(1e-3, scale)
            exp = np.exp(z - z.max())
            probabilities.append(exp / exp.sum())
        maximum = max(maximum, max_error(*probabilities))
    return maximum


def verify(model_dir, fixture_path, report):
    blob = fixture_path.read_bytes()
    digest = hashlib.sha256(blob).hexdigest()
    if digest != FIXTURE_SHA256:
        raise ValueError(f'Upstream fixture SHA256 mismatch: {digest}')
    fixture = json.loads(blob)
    if len(fixture['cases']) != 16 or sum(len(case['questions']) for case in fixture['cases']) != 63:
        raise ValueError('Expected all 16 upstream cases and 63 questions')
    report['fixture'] = {'url': FIXTURE_URL, 'sha256': digest, 'cases': 16, 'questions': 63}
    runtime = LayaRuntime(model_dir)
    try:
        loading = time.monotonic()
        runtime._load()  # Runs the production full-file SHA checks and CPU-only session setup.
        report['load_seconds'] = round(time.monotonic() - loading, 3)
        report['model_files_verified'] = True
        report['providers'] = runtime._session.get_providers()
        if runtime._config != fixture['config'] or runtime._special != fixture['special_tokens']:
            raise ValueError('Model config/special tokens differ from upstream fixture')
        mismatches = []
        for index, case in enumerate(fixture['tokenizer_cases']):
            ids = runtime._tokenizer.encode(case['text'], add_special_tokens=False).ids
            if ids != case['ids']:
                mismatches.append(index)
        report['tokenizer'] = {'cases': len(fixture['tokenizer_cases']), 'mismatches': mismatches}
        if mismatches:
            raise ValueError(f'Exact tokenizer parity failed for cases {mismatches}')
        overall = {key: 0. for key in THRESHOLDS}
        report['cases'], report['max_errors'] = [], overall
        for case in fixture['cases']:
            started = time.monotonic()
            name, qids = case['name'], list(case['questions'])
            state = case['state'] if isinstance(case['state'], str) else json.dumps(case['state'], ensure_ascii=False)
            row = {'name': name, 'questions': len(qids), 'failures': []}
            expected_rejection = POLICY['expected_production_rejection'].get(name)
            try:
                items, internal = prepare(runtime._tokenizer, runtime._special, runtime._config, state, case['questions'])
            except LayaContextOverflow as error:
                if error.section != expected_rejection:
                    raise
                row['production_input'] = {'status': 'rejected_as_required', 'section': error.section,
                    'tokens': error.tokens, 'limit': error.limit}
                items, internal = case['items'], case['internal']
                row['graph_input'] = 'Frozen upstream truncated tensors; not production accepted input'
            else:
                if expected_rejection:
                    raise ValueError(f'{name}: production silently accepted an upstream truncated input')
                if items != case['items'] or internal != case['internal']:
                    raise ValueError(f'{name}: exact prepared token/marker/question parity failed')
                row['production_input'] = {'status': 'exact'}
                row['graph_input'] = 'Production prepared tensors'
            batch = collate(items, runtime._special['pad'])
            if any(batch[key].tolist() != case['batch'][key] for key in batch):
                raise ValueError(f'{name}: exact collated tensor parity failed')
            row['tensor_contract'] = 'exact'
            logits, actions = runtime._session.run(['logits', 'act_logits'], batch)
            answers = format_answers(runtime._config, qids, internal, items, logits, actions)
            errors, choices = answer_errors(answers, case['result']['answers'])
            errors.update(logits=max_error(logits, case['logits']), act_logits=max_error(actions, case['act_logits']))
            errors['probability'] = max(errors['probability'],
                raw_probability_error(runtime._config, internal, logits, case['logits']))
            row['choice_mismatches'] = choices
            if choices:
                row['failures'].append('choice label changed')
            # Also exercise production question microbatching, not just the frozen full batch.
            if not expected_rejection:
                actual = runtime.predict(state, case['questions'])
                runtime_errors, runtime_choices = answer_errors(actual, case['result']['answers'])
                row['production_microbatch_errors'] = runtime_errors
                row['production_microbatch_choice_mismatches'] = runtime_choices
                if runtime_choices:
                    row['failures'].append('production microbatch choice label changed')
                for key, value in runtime_errors.items():
                    errors[key] = max(errors[key], value)
            row['max_errors'] = errors
            for key, value in errors.items():
                overall[key] = max(overall[key], value)
                if value > THRESHOLDS[key]:
                    row['failures'].append(f'{key} error {value:.8g} exceeds {THRESHOLDS[key]}')
            row['status'] = 'failed' if row['failures'] else 'passed'
            row['seconds'] = round(time.monotonic() - started, 3)
            report['cases'].append(row)
            print(json.dumps({'case': name, 'status': row['status'], 'seconds': row['seconds']}, ensure_ascii=False), flush=True)
        report['status'] = 'passed' if all(case['status'] == 'passed' for case in report['cases']) else 'failed'
        report['production_accepted_questions'] = sum(row['questions'] for row in report['cases'] if row['production_input']['status'] == 'exact')
        report['graph_questions'] = sum(row['questions'] for row in report['cases'])
    finally:
        runtime.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', type=Path, default=ROOT / 'tmp/laya-real/models' / SPEC['id'] / SPEC['revision'])
    parser.add_argument('--fixture', type=Path, default=ROOT / 'tmp/laya-audit/upstream/web/fixtures/parity-multilingual.json')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    parser.add_argument('--report', type=Path, default=ROOT / f'tmp/laya-parity/{stamp}/report.json')
    args = parser.parse_args()
    model_dir, fixture, output = map(inside_tmp, (args.model_dir, args.fixture, args.report))
    report = {'status': 'running', 'started_utc': datetime.now(timezone.utc).isoformat(),
              'runtime': {'python': sys.version.split()[0], 'onnxruntime': ort.__version__, 'numpy': np.__version__},
              'model': {'id': SPEC['id'], 'revision': SPEC['revision'], 'path': str(model_dir)}, 'policy': POLICY}
    started = time.monotonic()
    try:
        verify(model_dir, fixture, report)
    except Exception as error:
        report.update(status='failed', error={'type': type(error).__name__, 'message': str(error)})
    report['seconds'] = round(time.monotonic() - started, 3)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps({'status': report['status'], 'report': str(output), 'seconds': report['seconds']}, ensure_ascii=False))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
