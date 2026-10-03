"""聊天画像任务入口；复用本机限制、账号解析和独立画像服务。"""
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, ValidationError

from ..ai.insight_schemas import InsightTaskInput, InsightSelectedModel, Nonblank, LiveStateInput, LiveSettingsInput, LiveBatchInput
from ..ai.providers import ProviderFailure
from .ai import account_name, local_only


def get_insight_service():
    from ..ai.insights import get_insight_service as factory
    return factory()


router = APIRouter(prefix="/api/ai/insights", dependencies=[Depends(local_only)])


def live_options(body):
    return body.model_dump() | {'account': account_name(body.account)}


@router.post('/live/state')
async def live_state(body: LiveStateInput, service=Depends(get_insight_service)):
    try:
        return service.live.state(live_options(body))
    except (ValueError, ProviderFailure) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post('/live/settings')
async def live_settings(body: LiveSettingsInput, service=Depends(get_insight_service)):
    try:
        return await service.live.settings(live_options(body))
    except (ValueError, ProviderFailure) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post('/live/batches')
async def live_batch_create(body: LiveBatchInput, service=Depends(get_insight_service)):
    try:
        return service.live.create_batch(live_options(body))
    except (ValueError, ProviderFailure) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get('/live/batches/{id}')
async def live_batch(id: str, account: Nonblank, service=Depends(get_insight_service)):
    try:
        return service.live.get_batch(id, account_name(account))
    except KeyError as exc:
        raise HTTPException(404, '消息识别批次不存在') from exc


@router.post('/live/batches/{id}/cancel')
async def live_batch_cancel(id: str, account: Nonblank, service=Depends(get_insight_service)):
    try:
        return await service.live.cancel(id, account_name(account))
    except KeyError as exc:
        raise HTTPException(404, '消息识别批次不存在') from exc


@router.post("/tasks")
async def create_task(body: InsightTaskInput, service=Depends(get_insight_service)):
    data = body.model_dump()
    data["account"] = account_name(body.account)
    try:
        return service.create_task(data)
    except (ValueError, ProviderFailure) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/tasks")
async def tasks(account: Nonblank, username: str = Query(min_length=1, pattern=r"\S"),
                member_username: str = Query("", pattern=r"^$|\S"),
                limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                engine: Literal['api', 'laya'] | None = None,
                include_hidden: bool = False, selected_model: str | None = None,
                service=Depends(get_insight_service)):
    if member_username and not username.endswith("@chatroom"):
        raise HTTPException(422, "仅群聊可以选择成员画像")
    filters = {'engine': engine} if engine is not None else {}
    if include_hidden:
        filters['include_hidden'] = True
    if selected_model is not None:
        if engine != 'api':
            raise HTTPException(422, '仅明确选择 API 方式时可以筛选 API 模型')
        try:
            filters['selected_model'] = InsightSelectedModel.model_validate_json(selected_model).model_dump()
        except ValidationError as exc:
            raise HTTPException(422, str(exc)) from exc
    return service.list_tasks(account_name(account), username, member_username, limit, offset, **filters)


@router.delete('/tasks/history')
async def clear_task_history(account: Nonblank, engine: Literal['api', 'laya'],
                             username: str = Query(min_length=1, pattern=r'\S'),
                             member_username: str = Query('', pattern=r'^$|\S'),
                             service=Depends(get_insight_service)):
    if member_username and not username.endswith('@chatroom'):
        raise HTTPException(422, '仅群聊可以选择成员画像')
    return service.clear_task_history(account_name(account), username, member_username, engine)


@router.delete('/tasks/{id}/history')
async def delete_task_history(id: str, account: Nonblank, service=Depends(get_insight_service)):
    try:
        return service.delete_task_history(id, account_name(account))
    except KeyError as exc:
        raise HTTPException(404, '画像任务不存在') from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


class LocalModelImport(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    path: Nonblank


@router.get('/local-model')
async def local_model(service=Depends(get_insight_service)):
    return service.local_models.status()


@router.post('/local-model/download')
async def download_local_model(service=Depends(get_insight_service)):
    try:
        return await service.local_models.download()
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post('/local-model/pause')
async def pause_local_model(service=Depends(get_insight_service)):
    await service.local_models.pause()
    return service.local_models.status()


@router.post('/local-model/import')
async def import_local_model(body: LocalModelImport, service=Depends(get_insight_service)):
    try:
        return await service.local_models.import_model(body.path)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/tasks/{id}")
async def task(id: str, account: Nonblank, service=Depends(get_insight_service)):
    try:
        return service.get_task(id, account_name(account))
    except KeyError as exc:
        raise HTTPException(404, "画像任务不存在") from exc


@router.post("/tasks/{id}/cancel")
async def cancel_task(id: str, account: Nonblank, service=Depends(get_insight_service)):
    try:
        return await service.cancel(id, account_name(account))
    except KeyError as exc:
        raise HTTPException(404, "画像任务不存在") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/tasks/{id}/messages")
async def messages(id: str, account: Nonblank, limit: int = Query(100, ge=1, le=200),
                   offset: int = Query(0, ge=0), service=Depends(get_insight_service)):
    try:
        return service.messages(id, account_name(account), limit, offset)
    except KeyError as exc:
        raise HTTPException(404, "画像任务不存在") from exc


@router.get("/members")
async def members(account: Nonblank, username: str = Query(min_length=1, pattern=r"\S"),
                  service=Depends(get_insight_service)):
    if not username.endswith("@chatroom"):
        raise HTTPException(422, "仅群聊可以查询发言成员")
    try:
        return await service.members(account_name(account), username)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
