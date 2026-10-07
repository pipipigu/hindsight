"""A lost append race must be deferred, not failed (issue #5393).

An append reads the stored document, adds its turn and writes it back on condition the document
has not moved. Losing that race writes nothing — the precondition rejects the write whole — so
redoing it on a fresh read is always safe. The worker used to treat it like any other exception
and mark the operation terminally `failed`, which dropped the turn it carried.
"""

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hindsight_api.engine.memories.base import StoreWriteConflict
from hindsight_api.engine.retain.types import ConcurrentAppendConflict
from hindsight_api.worker.backpressure import is_append_conflict
from hindsight_api.worker.poller import _append_conflict_defer_seconds
from hindsight_api.worker.poller import ClaimedTask


def test_both_stores_lost_races_are_recognised():
    assert is_append_conflict(ConcurrentAppendConflict("document moved"))
    assert is_append_conflict(StoreWriteConflict("watermark mismatch"))


def test_it_is_found_through_wrapping():
    """The worker sees the conflict wrapped by whatever re-raised it."""
    try:
        try:
            raise ConcurrentAppendConflict("document moved")
        except Exception as inner:
            raise RuntimeError("retain failed for document chat-1") from inner
    except Exception as outer:
        assert is_append_conflict(outer)


def test_ordinary_failures_are_untouched():
    assert not is_append_conflict(ValueError("document_id must not be empty"))


def test_a_cycle_in_the_chain_terminates():
    a, b = Exception("a"), Exception("b")
    a.__cause__, b.__cause__ = b, a
    assert is_append_conflict(a) is False


def test_backoff_grows_and_is_capped():
    """Seconds at first — the winner is usually done by then — minutes at worst."""
    assert 1.0 <= _append_conflict_defer_seconds(1) <= 3.0
    assert _append_conflict_defer_seconds(1) < _append_conflict_defer_seconds(10)
    assert _append_conflict_defer_seconds(50) <= 450.0


def _make_poller(executor):
    from hindsight_api.worker import WorkerPoller

    poller = WorkerPoller(backend=MagicMock(), worker_id="w-test", executor=executor)
    poller._mark_completed = AsyncMock()
    poller._mark_failed = AsyncMock()
    poller._defer_operation = AsyncMock()
    poller._schedule_retry = AsyncMock()
    poller._append_conflict_defer_count = AsyncMock(return_value=2)
    return poller


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [ConcurrentAppendConflict("moved"), StoreWriteConflict("moved")])
async def test_a_lost_race_defers_instead_of_failing(error):
    async def losing(_task_dict):
        raise error

    poller = _make_poller(losing)
    task = ClaimedTask(
        operation_id=str(uuid.uuid4()),
        task_dict={
            "type": "batch_retain",
            "operation_type": "retain",
            "bank_id": "bank-1",
            "contents": [{"document_id": "chat-1", "update_mode": "append"}],
        },
        schema=None,
    )
    with patch("hindsight_api.worker.poller.get_metrics_collector", return_value=MagicMock()):
        await poller._execute_task_inner(task, None)

    poller._mark_failed.assert_not_awaited()
    poller._schedule_retry.assert_not_awaited()  # a deferral must not spend a retry
    poller._defer_operation.assert_awaited_once()
    _op_id, exec_date, reason, _schema, metadata = poller._defer_operation.await_args.args
    assert exec_date > datetime.now(timezone.utc)
    assert "append conflict" in reason
    # Rising count, so an append that keeps conflicting is an old pending operation, not a vanished one.
    assert metadata == {"append_conflict_defers": 3}
