"""已确认事实的十进制计算；不推断事件关系，也不执行模型提供的代码。"""
from decimal import Decimal, localcontext
from typing import Literal

from pydantic import BaseModel, Field


class CalculationTerm(BaseModel):
    event_key: str = Field(min_length=1, max_length=200, description='已确认的唯一事件编号；重复引用同一事件使用同一编号')
    value: str = Field(pattern=r'^-?\d{1,30}(\.\d{1,8})?$', description='原文支持的十进制数值；方向确认后才使用负数')
    sources: list[str] = Field(min_length=1, max_length=30, description='支持数值和事件关系的真实消息编号')
    confirmed: Literal[True] = Field(description='仅在事件、数值及方向都已确认时设为 true；待确认项不能参与计算')


def calculate(terms, operation):
    if not terms or len(terms) > 1000:
        raise ValueError('每次计算需要 1 至 1000 个已确认事件')
    if len({t.event_key for t in terms}) != len(terms):
        raise ValueError('包含重复事件编号；先确认重复引用是否为同一事件，再计算')
    with localcontext() as context:
        context.prec = 80
        values = [Decimal(t.value) for t in terms]
        if operation == 'sum':
            value = sum(values, Decimal(0))
        elif operation == 'difference':
            value = values[0] - sum(values[1:], Decimal(0))
        elif operation == 'min':
            value = min(values)
        elif operation == 'max':
            value = max(values)
        else:
            raise ValueError('不支持的计算方式')
    return {'operation': operation, 'value': format(value, 'f'), 'event_count': len(terms),
        'sources': list(dict.fromkeys(s for t in terms for s in t.sources)),
        'instruction': '程序只保证所列已确认事件的数值运算；不证明聊天范围完整，未确认关系仍需单独说明。'}
