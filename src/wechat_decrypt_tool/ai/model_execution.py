"""模型步骤的执行预算；与供应商声明的最大窗口、最大输出分开。"""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass


@dataclass(frozen=True)
class CallPolicy:
    seconds: float = 180
    output_tokens: int | None = None
    split_on_failure: bool = False
    auxiliary: bool = False


call_policy = ContextVar('ai_call_policy', default=CallPolicy())
ANSWER_SECONDS = 240
DECISION_SECONDS = 90
MATERIAL_BATCH_BYTES = 48 * 1024
MIN_BATCH_BYTES = 6 * 1024
NOTE_BYTES = 16 * 1024


class ResegmentModelError(RuntimeError):
    """上游暂时失败；由资料层缩小批次，避免原样重发大请求。"""


class RetryAnalysisBatch(RuntimeError):
    """原文已重新排队，调度器下一步继续处理，不能提前标记分析完成。"""


@contextmanager
def model_policy(**kwargs):
    token = call_policy.set(CallPolicy(**kwargs))
    try:
        yield
    finally:
        call_policy.reset(token)
