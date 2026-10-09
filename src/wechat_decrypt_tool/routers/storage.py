"""Local, explicit account storage inspection and index cleanup."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from .ai import local_only
from ..logging_config import get_logger
from ..snapshot_registry import SnapshotRegistryError
from ..storage_service import cleanup_search_indexes, storage_summary


router = APIRouter(prefix='/api/storage', dependencies=[Depends(local_only)])
logger = get_logger(__name__)


class CleanupRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    category: Literal['search_index']


def _call(operation, account):
    try:
        return operation(account)
    except HTTPException as error:
        if error.status_code >= 500:
            logger.exception('Account storage operation failed for %s', account)
        raise
    except SnapshotRegistryError as error:
        raise HTTPException(409, {'code': 'storage_not_available', 'message': str(error),
            'removed_bytes': 0, 'removed_files': 0}) from error
    except (OSError, ValueError) as error:
        logger.exception('Account storage operation failed for %s', account)
        raise HTTPException(500, {'code': 'storage_failed', 'message': str(error),
            'removed_bytes': 0, 'removed_files': 0}) from error


@router.get('')
def get_storage(account: str = Query(..., min_length=1)):
    return _call(storage_summary, account)


@router.post('/cleanup')
def cleanup_storage(body: CleanupRequest, account: str = Query(..., min_length=1)):
    return _call(cleanup_search_indexes, account)
