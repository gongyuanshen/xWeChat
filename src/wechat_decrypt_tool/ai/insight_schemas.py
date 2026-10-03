"""聊天画像入口与模型输出契约；缺失、类型错误和无出处结论直接失败。"""
from __future__ import annotations

import time
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from .model_selection import SelectedModel


def nonblank(value: str) -> str:
    if not value.strip():
        raise ValueError("文本不能只包含空白")
    return value


Nonblank = Annotated[str, Field(min_length=1), AfterValidator(nonblank)]
ShortLabel = Annotated[str, Field(min_length=1, max_length=4), AfterValidator(nonblank)]


class StrictModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class InsightSelectedModel(SelectedModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class InsightTaskInput(StrictModel):
    account: Nonblank
    username: Nonblank
    member_username: str = ""
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    engine: Literal['api', 'laya'] = 'api'
    selected_model: InsightSelectedModel | None = None
    reuse_existing: bool = True

    @model_validator(mode="after")
    def validate_range_and_member(self):
        if self.engine == 'laya' and self.selected_model is not None:
            raise ValueError('本地 Laya 不能同时指定 API 模型')
        if self.end <= self.start:
            raise ValueError("结束时间必须晚于开始时间")
        if self.end > int(time.time()):
            raise ValueError("结束时间不能晚于当前时间")
        if self.member_username:
            nonblank(self.member_username)
            if not self.username.endswith("@chatroom"):
                raise ValueError("仅群聊可以选择成员画像")
        return self


class EvidenceText(StrictModel):
    text: str
    sources: list[Nonblank]

    @model_validator(mode="after")
    def validate_evidence(self):
        if self.text.strip() and not self.sources:
            raise ValueError("非空结论必须提供原文出处")
        return self


class Score(StrictModel):
    score: int | None = Field(ge=0, le=100)
    reason: Nonblank
    sources: list[Nonblank]

    @model_validator(mode="after")
    def validate_evidence(self):
        if self.score is not None and not self.sources:
            raise ValueError("已知分数必须提供原文出处")
        return self


class Traits(StrictModel):
    energy: Score
    humor: Score
    calm: Score
    initiative: Score
    care: Score
    closeness: Score


class MBTI(StrictModel):
    EI: Score
    SN: Score
    TF: Score
    JP: Score


class Portrait(StrictModel):
    summary: EvidenceText
    topics: list[EvidenceText]
    communication: list[EvidenceText]
    mood: EvidenceText | None
    traits: Traits
    affinity: Score | None
    mbti: MBTI | None
    uncertain: list[Nonblank]


class MessageLabel(StrictModel):
    source: Nonblank
    emotion: ShortLabel | None
    intent: ShortLabel | None
    reason: Nonblank
    sources: list[Nonblank]

    @model_validator(mode="after")
    def validate_evidence(self):
        if (self.emotion is not None or self.intent is not None) and not self.sources:
            raise ValueError("非空标签必须提供原文出处")
        return self


class LabelsOutput(StrictModel):
    labels: list[MessageLabel] = Field(min_length=1)


class LiveScope(StrictModel):
    account: Nonblank
    username: Nonblank
    engine: Literal['api', 'laya'] = 'api'
    selected_model: InsightSelectedModel | None = None

    @model_validator(mode='after')
    def validate_engine(self):
        if self.engine == 'laya' and self.selected_model is not None:
            raise ValueError('本地 Laya 不能同时指定 API 模型')
        return self


class LiveMessageRef(StrictModel):
    identity: Nonblank
    time: int = Field(ge=0)
    fingerprint: str = Field(pattern=r'^[0-9a-f]{64}$')


class LiveStateInput(LiveScope):
    messages: list[LiveMessageRef] = Field(default_factory=list, max_length=200)


class LiveSettingsInput(LiveScope):
    enabled: bool


class LiveBatchInput(LiveScope):
    messages: list[LiveMessageRef] = Field(min_length=1, max_length=20)
    context: list[LiveMessageRef] = Field(default_factory=list, max_length=3)
    retry: bool = False

    @model_validator(mode='after')
    def validate_refs(self):
        refs = [*self.context, *self.messages]
        if len({ref.identity for ref in refs}) != len(refs):
            raise ValueError('消息和前文不能包含重复身份')
        if self.context and max(ref.time for ref in self.context) > min(ref.time for ref in self.messages):
            raise ValueError('相邻上下文必须早于当前批次')
        return self
