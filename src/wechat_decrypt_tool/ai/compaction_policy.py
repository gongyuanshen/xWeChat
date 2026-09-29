"""按模型配置的上下文策略；字节上限与请求预算比例分别命名。"""
from pydantic import BaseModel, ConfigDict, Field, model_validator


class CompactionPolicy(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)

    pressure_ratio: float = Field(.80, gt=.1, lt=1)
    target_ratio: float = Field(.60, gt=.05, lt=1)
    history_ratio: float = Field(.30, gt=.05, lt=1)
    recent_ratio: float = Field(.16, gt=0, lt=1)
    recent_turns: int = Field(2, ge=1, le=20)
    history_summary_ratio: float = Field(.10, gt=0, lt=1)
    history_summary_bytes: int = Field(8192, ge=512, le=65536)
    note_ratio: float = Field(.20, gt=0, lt=1)
    material_tail_ratio: float = Field(.15, ge=0, lt=1)
    summary_attempts: int = Field(3, ge=1, le=5)
    summary_output_tokens: int = Field(8192, ge=1024, le=32768)
    summary_timeout_seconds: int = Field(120, ge=30, le=240)
    overflow_retries: int = Field(2, ge=0, le=5)
    usage_calibration: bool = True

    @model_validator(mode='after')
    def check_ratios(self):
        if not self.target_ratio < self.pressure_ratio:
            raise ValueError('整理后目标必须小于压缩触发比例。')
        if not self.history_summary_ratio < self.history_ratio < self.pressure_ratio:
            raise ValueError('历史摘要比例必须小于历史触发比例，且后者小于总体触发比例。')
        if self.recent_ratio >= self.history_ratio or self.note_ratio >= self.target_ratio:
            raise ValueError('近期保留或阶段笔记比例超过对应预算。')
        return self


def policy_for(profile):
    return CompactionPolicy.model_validate(profile.get('compaction_policy') or {})
