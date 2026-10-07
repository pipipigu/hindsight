"""Concurrent appends to one document must not drop a turn (issue #5393).

An append is a read-modify-write: it reads the stored document, adds its turn and
writes it back on condition the document has not moved. Losing that race writes
nothing, so the answer is "read it again", not "this content was bad".

The worker used to disagree. Any exception other than a retry or backpressure
marked the operation terminally `failed`, so an append that lost its race more
times than the pipeline redoes it in-process ended as a failure and the turn it
carried was simply gone — a conversation missing a message, with a failed
operation that reads like the content was at fault.

Synchronous appends are the sharpest way to produce that contention from outside:
nothing serialises them, so a burst of them collides on purpose, which is exactly
the race a queued append can also lose against.
"""

from __future__ import annotations

import asyncio

import pytest

from hindsight_system_tests.payloads import consolidation, extracted

pytestmark = pytest.mark.asyncio

DOCUMENT_ID = "session-burst"
FIRST = "Alice opened the session."
QUEUED_TURNS = [f"Queued turn {i}." for i in range(1, 7)]
SYNC_TURNS = [f"Sync turn {i}." for i in range(1, 13)]


@pytest.fixture(autouse=True)
def _extraction(llm):
    # The story is about which turns survive, not what was extracted from them,
    # so every turn extracts nothing and the document text carries the whole claim.
    llm.on_step("extract_facts").returns(extracted())
    llm.on_step("consolidate").returns(consolidation())


async def test_a_burst_of_appends_to_one_document_loses_nothing(client, bank_id, settled):
    await client.aretain(bank_id=bank_id, content=FIRST, document_id=DOCUMENT_ID)
    await settled(bank_id)

    async def append(turn: str, queued: bool):
        return await client.aretain(
            bank_id=bank_id,
            content=turn,
            document_id=DOCUMENT_ID,
            update_mode="append",
            retain_async=queued,
        )

    results = await asyncio.gather(
        *(append(turn, queued=True) for turn in QUEUED_TURNS),
        *(append(turn, queued=False) for turn in SYNC_TURNS),
        return_exceptions=True,
    )
    await settled(bank_id)

    queued_results = results[: len(QUEUED_TURNS)]
    assert not [r for r in queued_results if isinstance(r, BaseException)], (
        f"a queued append was rejected outright: {queued_results}"
    )
    for response in queued_results:
        status = await client.operations.get_operation_status(bank_id, response.operation_id)
        assert status.status == "completed", f"{status.status}: {status.error_message}"

    # Every queued turn is in the document. A synchronous append may still be told
    # the document moved — it has no queue to be re-run from — so those are only
    # required to be all-or-nothing, never half-applied.
    document = await client.documents.get_document(bank_id, DOCUMENT_ID)
    text = document.original_text or ""
    assert text.startswith(FIRST)
    for turn in QUEUED_TURNS:
        assert turn in text, f"queued turn lost: {turn}\n{text}"
    for turn, result in zip(SYNC_TURNS, results[len(QUEUED_TURNS) :]):
        if not isinstance(result, BaseException):
            assert turn in text, f"a synchronous append reported success but its turn is missing: {turn}\n{text}"
