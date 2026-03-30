# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0

"""Service-level tests for content write coordination."""

import pytest

from openviking.server.identity import RequestContext, Role
from openviking.service.content_write_coordinator import ContentWriteCoordinator
from openviking_cli.exceptions import DeadlineExceededError, NotFoundError
from openviking_cli.session.user_id import UserIdentifier


@pytest.mark.asyncio
async def test_write_updates_memory_file_and_parent_overview(service):
    ctx = RequestContext(user=service.user, role=Role.USER)
    memory_dir = f"viking://user/{ctx.user.user_space_name()}/memories/preferences"
    memory_uri = f"{memory_dir}/theme.md"

    await service.viking_fs.write_file(memory_uri, "Original preference", ctx=ctx)

    result = await service.fs.write(
        memory_uri,
        content="Updated preference",
        ctx=ctx,
        mode="replace",
        wait=True,
    )

    assert result["context_type"] == "memory"
    assert await service.viking_fs.read_file(memory_uri, ctx=ctx) == "Updated preference"
    assert await service.viking_fs.read_file(f"{memory_dir}/.overview.md", ctx=ctx)
    assert await service.viking_fs.read_file(f"{memory_dir}/.abstract.md", ctx=ctx)


@pytest.mark.asyncio
async def test_write_denies_foreign_user_memory_space(service):
    owner_ctx = RequestContext(user=service.user, role=Role.USER)
    memory_uri = (
        f"viking://user/{owner_ctx.user.user_space_name()}/memories/preferences/private-note.md"
    )
    await service.viking_fs.write_file(memory_uri, "Owner note", ctx=owner_ctx)

    foreign_ctx = RequestContext(
        user=UserIdentifier(owner_ctx.account_id, "other_user", owner_ctx.user.agent_id),
        role=Role.USER,
    )

    with pytest.raises(NotFoundError):
        await service.fs.write(
            memory_uri,
            content="Intruder update",
            ctx=foreign_ctx,
            regenerate_semantics=False,
            revectorize=False,
        )


class _FakeHandle:
    def __init__(self, handle_id: str):
        self.id = handle_id


class _FakeLockManager:
    def __init__(self):
        self.handle = _FakeHandle("lock-1")
        self.release_calls = []

    def create_handle(self):
        return self.handle

    async def acquire_subtree(self, handle, path):
        del handle, path
        return True

    async def release(self, handle):
        self.release_calls.append(handle.id)


class _FakeVikingFS:
    def __init__(self, file_uri: str, root_uri: str):
        self._file_uri = file_uri
        self._root_uri = root_uri
        self.delete_temp_calls = []

    async def stat(self, uri: str, ctx=None):
        del ctx
        if uri == self._file_uri:
            return {"isDir": False}
        if uri == self._root_uri:
            return {"isDir": True}
        raise AssertionError(f"unexpected stat uri: {uri}")

    def _uri_to_path(self, uri: str, ctx=None):
        del ctx
        return f"/fake/{uri.replace('://', '/').strip('/')}"

    async def delete_temp(self, temp_uri: str, ctx=None):
        del ctx
        self.delete_temp_calls.append(temp_uri)


@pytest.mark.asyncio
async def test_write_timeout_after_enqueue_does_not_release_resource_lock(monkeypatch):
    file_uri = "viking://resources/demo/doc.md"
    root_uri = "viking://resources/demo"
    ctx = RequestContext(user=UserIdentifier.the_default_user(), role=Role.USER)
    viking_fs = _FakeVikingFS(file_uri=file_uri, root_uri=root_uri)
    coordinator = ContentWriteCoordinator(viking_fs=viking_fs)
    lock_manager = _FakeLockManager()

    monkeypatch.setattr(
        "openviking.service.content_write_coordinator.get_lock_manager",
        lambda: lock_manager,
    )

    async def _fake_prepare_temp_write(**kwargs):
        del kwargs
        return "viking://temp/demo", "viking://temp/demo/doc.md"

    async def _fake_enqueue_semantic_refresh(**kwargs):
        del kwargs
        return None

    async def _fake_wait_for_queues(*, timeout):
        raise DeadlineExceededError("queue processing", timeout)

    monkeypatch.setattr(coordinator, "_prepare_temp_write", _fake_prepare_temp_write)
    monkeypatch.setattr(coordinator, "_enqueue_semantic_refresh", _fake_enqueue_semantic_refresh)
    monkeypatch.setattr(coordinator, "_wait_for_queues", _fake_wait_for_queues)

    with pytest.raises(DeadlineExceededError):
        await coordinator.write(
            uri=file_uri,
            content="updated",
            ctx=ctx,
            wait=True,
        )

    assert lock_manager.release_calls == []
    assert viking_fs.delete_temp_calls == []


@pytest.mark.asyncio
async def test_memory_write_timeout_after_enqueue_does_not_release_lock(monkeypatch):
    file_uri = "viking://user/default/memories/preferences/theme.md"
    root_uri = "viking://user/default/memories/preferences"
    ctx = RequestContext(user=UserIdentifier.the_default_user(), role=Role.USER)
    viking_fs = _FakeVikingFS(file_uri=file_uri, root_uri=root_uri)
    coordinator = ContentWriteCoordinator(viking_fs=viking_fs)
    lock_manager = _FakeLockManager()

    monkeypatch.setattr(
        "openviking.service.content_write_coordinator.get_lock_manager",
        lambda: lock_manager,
    )

    async def _fake_write_in_place(uri, content, *, mode, ctx):
        del uri, content, mode, ctx
        return None

    async def _fake_vectorize_single_file(uri, *, context_type, ctx):
        del uri, context_type, ctx
        return None

    async def _fake_enqueue_memory_refresh(**kwargs):
        del kwargs
        return None

    async def _fake_wait_for_queues(*, timeout):
        raise DeadlineExceededError("queue processing", timeout)

    monkeypatch.setattr(coordinator, "_write_in_place", _fake_write_in_place)
    monkeypatch.setattr(coordinator, "_vectorize_single_file", _fake_vectorize_single_file)
    monkeypatch.setattr(coordinator, "_enqueue_memory_refresh", _fake_enqueue_memory_refresh)
    monkeypatch.setattr(coordinator, "_wait_for_queues", _fake_wait_for_queues)

    with pytest.raises(DeadlineExceededError):
        await coordinator.write(
            uri=file_uri,
            content="updated",
            ctx=ctx,
            wait=True,
        )

    assert lock_manager.release_calls == []
