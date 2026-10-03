"""模型步骤的执行预算；与供应商声明的最大窗口、最大输出分开。"""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, replace


@dataclass(frozen=True)
class CallPolicy:
    seconds: float = 120.0
    output_tokens: int | None = None
    tokens: int = 4096
    step_timeout: float = 120.0
    constrain_thinking: bool = False
    split_on_failure: bool = True
    auxiliary: bool = False
    strict_output: bool = False


call_policy = ContextVar('ai_call_policy', default=CallPolicy())
ANSWER_SECONDS = 240
DECISION_SECONDS = 90
MATERIAL_BATCH_BYTES = 48 * 1024
MIN_BATCH_BYTES = 6 * 1024
NOTE_BYTES = 16 * 1024

# --- Milestone M1 Micro-Batch & Timeout Contracts ---
MICRO_BATCH_MIN_BYTES: int = 12 * 1024       # 12 KiB lower bound (12288 bytes)
MICRO_BATCH_MAX_BYTES: int = 16 * 1024       # 16 KiB upper bound (16384 bytes)
MICRO_BATCH_MAX_MESSAGES: int = 150          # ~80-150 messages
STEP_HARD_TIMEOUT_SECONDS: float = 120.0     # 120s execution limit


class ResegmentModelError(RuntimeError):
    """上游暂时失败；由资料层缩小批次，避免原样重发大请求。"""


class RetryAnalysisBatch(RuntimeError):
    """原文已重新排队，调度器下一步继续处理，不能提前标记分析完成。"""


@contextmanager
def model_policy(**kwargs):
    token = call_policy.set(replace(call_policy.get(), **kwargs))
    try:
        yield
    finally:
        call_policy.reset(token)
