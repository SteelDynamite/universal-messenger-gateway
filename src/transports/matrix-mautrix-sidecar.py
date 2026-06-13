#!/usr/bin/env python3
"""Minimal mautrix JSON-lines sidecar for the Matrix transport spike."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import sys
import time
from pathlib import Path
from typing import Any

from mautrix.client import Client
from mautrix.client.state_store import FileStateStore
from mautrix.crypto import OlmMachine
from mautrix.crypto.store import PgCryptoStateStore, PgCryptoStore
from mautrix.types import (
    EventType,
    Format,
    InReplyTo,
    Membership,
    MessageEvent,
    MessageType,
    ReactionEvent,
    RelationType,
    RelatesTo,
    StateEvent,
    TextMessageEventContent,
    TrustState,
)
from mautrix.util.async_db import Database

class JsonLineErrorHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        if "Failed to decrypt" not in message:
            return
        match = re.search(r"Failed to decrypt (\$[^: ]+)", message)
        sys.stdout.write(
            json.dumps(
                {
                    "type": "error",
                    "category": "matrix-decryption",
                    "eventId": match.group(1) if match else None,
                    "error": message,
                },
                separators=(",", ":"),
            )
            + "\n"
        )
        sys.stdout.flush()


logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
logging.getLogger("mau.client.crypto").addHandler(JsonLineErrorHandler())


class Sidecar:
    def __init__(self) -> None:
        self.client: Client | None = None
        self.crypto_db: Database | None = None
        self.crypto_store: PgCryptoStore | None = None
        self.state_store: FileStateStore | None = None
        self.bot_user_id = ""
        self.joined_rooms: set[str] = set()
        self.pending_invites: dict[str, dict[str, Any]] = {}
        self.room_member_count: dict[str, int] = {}
        self.connected_at = 0
        self.state_dir: Path | None = None

    async def connect(self, command: dict[str, Any]) -> dict[str, Any]:
        state_dir = Path(str(command["stateDir"])).resolve()
        state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        state_dir.chmod(0o700)
        self.state_dir = state_dir
        homeserver_url = str(command["homeserverUrl"])
        access_token = str(command["accessToken"])
        encryption = bool(command.get("encryption", True))

        crypto_db = None
        crypto_store = None
        if encryption:
            crypto_db = Database.create(
                f"sqlite:///{state_dir / 'mautrix-crypto.db'}",
                upgrade_table=None,
                log=logging.getLogger("umg.mautrix.crypto.db"),
            )
            await crypto_db.start()
            await PgCryptoStore.upgrade_table.upgrade(crypto_db)
            await PgCryptoStateStore.upgrade_table.upgrade(crypto_db)
            chmod_crypto_files(state_dir)
            state_store = PgCryptoStateStore(crypto_db)
            crypto_store = PgCryptoStore("", "umg.mautrix", crypto_db)
            await crypto_store.open()
            chmod_crypto_files(state_dir)
        else:
            state_store = FileStateStore(state_dir / "mautrix-state.pickle")
            await state_store.open()
            chmod_crypto_files(state_dir)

        client = Client(
            base_url=homeserver_url,
            token=access_token,
            state_store=state_store,
            sync_store=crypto_store,
        )
        whoami = await client.whoami()
        client.mxid = whoami.user_id
        if whoami.device_id:
            client.device_id = whoami.device_id
        self.bot_user_id = str(whoami.user_id)
        self.state_store = state_store

        if encryption and crypto_db and crypto_store:
            stored_device_id = await crypto_store.get_device_id()
            if stored_device_id and whoami.device_id and str(stored_device_id) != str(whoami.device_id):
                raise RuntimeError(
                    "Matrix access token device does not match mautrix crypto DB device; "
                    "clear mautrix-crypto.db or use the matching access token"
                )
            if stored_device_id:
                client.device_id = stored_device_id
            elif whoami.device_id:
                await crypto_store.put_device_id(whoami.device_id)
            crypto = OlmMachine(client, crypto_store, state_store)
            crypto.share_keys_min_trust = TrustState.UNVERIFIED
            crypto.send_keys_min_trust = TrustState.UNVERIFIED
            client.crypto = crypto
            await crypto.load()
            if not crypto.account.shared:
                await crypto.share_keys()
            self.crypto_db = crypto_db
            self.crypto_store = crypto_store

        client.add_event_handler(EventType.ROOM_MESSAGE, self.handle_message)
        client.add_event_handler(EventType.REACTION, self.handle_reaction)
        client.add_event_handler(EventType.ROOM_MEMBER, self.handle_member)
        self.client = client
        self.connected_at = now_ms()
        self.joined_rooms = set(str(room) for room in await client.get_joined_rooms())
        for room_id in list(self.joined_rooms):
            await self.refresh_room_member_count(room_id)
        client.start(None)
        return {"userId": self.bot_user_id, "deviceId": str(getattr(client, "device_id", ""))}

    async def disconnect(self) -> None:
        if self.client:
            self.client.stop()
        if self.state_store:
            await self.state_store.close()
        if self.crypto_store:
            await self.crypto_store.close()
        if self.crypto_db:
            await self.crypto_db.stop()
            if self.state_dir:
                chmod_crypto_files(self.state_dir)
        self.client = None
        self.crypto_db = None
        self.crypto_store = None
        self.state_store = None
        self.joined_rooms.clear()
        self.pending_invites.clear()
        self.room_member_count.clear()
        self.state_dir = None

    async def list_chats(self) -> list[dict[str, Any]]:
        client = require_client(self.client)
        self.joined_rooms = set(str(room) for room in await client.get_joined_rooms())
        return [
            compact({"chatId": room_id, "displayName": await self.room_display_name(room_id)})
            for room_id in sorted(self.joined_rooms)
        ]

    async def list_invites(self) -> list[dict[str, Any]]:
        return list(self.pending_invites.values())

    async def health(self) -> list[dict[str, Any]]:
        if not self.client:
            return [{"category": "matrix-e2ee", "status": "disabled", "summary": "not connected"}]
        if not self.crypto_store:
            return [{"category": "matrix-e2ee", "status": "disabled", "summary": "encryption disabled"}]
        return [
            {
                "category": "matrix-e2ee",
                "status": "ready",
                "summary": "mautrix crypto store ready",
                "details": ["store: sqlite", "sidecar: python mautrix"],
            }
        ]

    async def send_message(self, command: dict[str, Any]) -> None:
        client = require_client(self.client)
        room_id = str(command["chatId"])
        content = TextMessageEventContent(msgtype=MessageType.TEXT, body=str(command["text"]))
        formatted_body = command.get("formattedBody")
        if isinstance(formatted_body, str):
            content.format = Format.HTML
            content.formatted_body = formatted_body
        relates_to = make_relates_to(room_id, command.get("replyTo"), command.get("threadTo"))
        if relates_to:
            content.relates_to = relates_to
        await client.send_message(room_id, content)

    async def send_reaction(self, command: dict[str, Any]) -> None:
        await require_client(self.client).react(
            str(command["chatId"]), str(command["messageId"]), str(command["reaction"])
        )

    async def send_typing(self, command: dict[str, Any]) -> None:
        await require_client(self.client).set_typing(str(command["chatId"]), 10000)

    async def leave_chat(self, command: dict[str, Any]) -> None:
        room_id = str(command["chatId"])
        await require_client(self.client).leave_room(room_id, command.get("reason"))
        self.joined_rooms.discard(room_id)
        self.room_member_count.pop(room_id, None)

    async def accept_invite(self, command: dict[str, Any]) -> None:
        room_id = str(command["inviteId"])
        joined = str(await require_client(self.client).join_room_by_id(room_id))
        self.pending_invites.pop(room_id, None)
        self.joined_rooms.add(joined)

    async def reject_invite(self, command: dict[str, Any]) -> None:
        room_id = str(command["inviteId"])
        await require_client(self.client).leave_room(room_id, command.get("reason"), raise_not_in_room=False)
        self.pending_invites.pop(room_id, None)

    async def handle_message(self, event: MessageEvent) -> None:
        room_id = str(event.room_id)
        raw_content = serialize(event.content)
        if should_skip_message(event, raw_content, self.bot_user_id, self.connected_at, self.joined_rooms):
            return
        body = str(raw_content.get("body") or "")
        attachment = media_attachment(raw_content)
        if not body and not attachment:
            return
        member_count = self.room_member_count.get(room_id)
        if member_count is None:
            member_count = await self.refresh_room_member_count(room_id)
        is_group_chat = member_count > 2
        was_mentioned = is_group_chat and was_bot_mentioned(body, self.bot_user_id)
        content = strip_bot_mention(body, self.bot_user_id) if was_mentioned else body
        if not content and not attachment:
            return
        message = compact(
            {
                "chatId": room_id,
                "transport": "matrix",
                "content": content,
                "username": extract_username(str(event.sender)),
                "userId": str(event.sender),
                "timestamp": int(event.timestamp or now_ms()),
                "messageId": str(event.event_id) if event.event_id else None,
                "isGroupChat": is_group_chat,
                "wasMentioned": was_mentioned,
                "attachments": [attachment] if attachment else None,
                **message_references(room_id, raw_content),
            }
        )
        await emit({"type": "message", "message": message})

    async def handle_reaction(self, event: ReactionEvent) -> None:
        room_id = str(event.room_id)
        if str(event.sender) == self.bot_user_id or int(event.timestamp or 0) < self.connected_at:
            return
        if room_id not in self.joined_rooms:
            return
        relates_to = serialize(event.content).get("m.relates_to") or {}
        if relates_to.get("rel_type") != "m.annotation":
            return
        event_id = relates_to.get("event_id")
        key = relates_to.get("key")
        if not isinstance(event_id, str) or not isinstance(key, str):
            return
        await emit(
            {
                "type": "reaction",
                "reaction": compact(
                    {
                        "chatId": room_id,
                        "transport": "matrix",
                        "messageId": event_id,
                        "reaction": key,
                        "timestamp": int(event.timestamp or now_ms()),
                        "reactionId": str(event.event_id) if event.event_id else None,
                        "username": extract_username(str(event.sender)),
                        "userId": str(event.sender),
                    }
                ),
            }
        )

    async def handle_member(self, event: StateEvent) -> None:
        room_id = str(event.room_id)
        content = event.content
        membership = getattr(content, "membership", None)
        state_key = str(getattr(event, "state_key", ""))
        if state_key == self.bot_user_id and membership == Membership.INVITE:
            invite = compact(
                {
                    "inviteId": room_id,
                    "inviter": str(event.sender) if event.sender else None,
                    "displayName": invite_display_name(event),
                }
            )
            self.pending_invites[room_id] = invite
            await emit({"type": "invite", "invite": invite})
        elif state_key == self.bot_user_id and membership == Membership.JOIN:
            self.pending_invites.pop(room_id, None)
            self.joined_rooms.add(room_id)
            await self.refresh_room_member_count(room_id)
        elif state_key == self.bot_user_id and membership in (Membership.LEAVE, Membership.BAN):
            self.pending_invites.pop(room_id, None)
            self.joined_rooms.discard(room_id)
            self.room_member_count.pop(room_id, None)
        elif room_id in self.joined_rooms:
            await self.refresh_room_member_count(room_id)

    async def room_display_name(self, room_id: str) -> str | None:
        client = require_client(self.client)
        try:
            content = await client.get_state_event(room_id, EventType.ROOM_NAME)
            name = getattr(content, "name", None) or serialize(content).get("name")
            if isinstance(name, str) and name.strip():
                return name.strip()
        except Exception:
            pass
        try:
            content = await client.get_state_event(room_id, EventType.ROOM_CANONICAL_ALIAS)
            alias = getattr(content, "alias", None) or serialize(content).get("alias")
            if isinstance(alias, str) and alias.strip():
                return alias.strip()
        except Exception:
            pass
        return None

    async def refresh_room_member_count(self, room_id: str) -> int:
        try:
            count = len(await require_client(self.client).get_joined_members(room_id))
        except Exception:
            count = 2
        self.room_member_count[room_id] = count
        return count


async def run() -> None:
    sidecar = Sidecar()
    handlers = {
        "connect": sidecar.connect,
        "disconnect": lambda command: sidecar.disconnect(),
        "list_chats": lambda command: sidecar.list_chats(),
        "list_invites": lambda command: sidecar.list_invites(),
        "health": lambda command: sidecar.health(),
        "send_message": sidecar.send_message,
        "send_reaction": sidecar.send_reaction,
        "send_typing": sidecar.send_typing,
        "leave_chat": sidecar.leave_chat,
        "accept_invite": sidecar.accept_invite,
        "reject_invite": sidecar.reject_invite,
    }
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            command = json.loads(line)
            command_id = command.get("id")
            try:
                handler = handlers[str(command.get("type"))]
                result = await handler(command)
                await emit({"id": command_id, "ok": True, "result": result})
            except Exception as error:
                await emit({"id": command_id, "ok": False, "error": str(error)})
    finally:
        await sidecar.disconnect()


async def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def require_client(client: Client | None) -> Client:
    if not client:
        raise RuntimeError("Matrix client not connected")
    return client


def make_relates_to(room_id: str, reply_to: Any, thread_to: Any) -> RelatesTo | None:
    valid_reply = message_ref_for_room(reply_to, room_id)
    valid_thread = message_ref_for_room(thread_to, room_id)
    if valid_thread:
        return RelatesTo(
            rel_type=RelationType.THREAD,
            event_id=valid_thread,
            in_reply_to=InReplyTo(event_id=valid_reply or valid_thread),
            is_falling_back=None if valid_reply else True,
        )
    if valid_reply:
        return RelatesTo(in_reply_to=InReplyTo(event_id=valid_reply))
    return None


def message_ref_for_room(value: Any, room_id: str) -> str | None:
    if not isinstance(value, dict):
        return None
    if value.get("transport") != "matrix" or value.get("chatId") != room_id:
        return None
    message_id = value.get("messageId")
    return message_id if isinstance(message_id, str) else None


def should_skip_message(
    event: MessageEvent,
    content: dict[str, Any],
    bot_user_id: str,
    connected_at: int,
    joined_rooms: set[str],
) -> bool:
    if str(event.sender) == bot_user_id:
        return True
    if int(event.timestamp or 0) < connected_at:
        return True
    if str(event.room_id) not in joined_rooms:
        return True
    if content.get("m.new_content"):
        return True
    if content.get("msgtype") == "m.text":
        return not bool(content.get("body"))
    return media_attachment(content) is None


def message_references(room_id: str, content: dict[str, Any]) -> dict[str, Any]:
    relates_to = content.get("m.relates_to") or {}
    if not isinstance(relates_to, dict):
        return {}
    thread_root = relates_to.get("event_id") if relates_to.get("rel_type") == "m.thread" else None
    reply_event_id = None
    in_reply_to = relates_to.get("m.in_reply_to")
    if isinstance(in_reply_to, dict) and isinstance(in_reply_to.get("event_id"), str):
        reply_event_id = in_reply_to.get("event_id")
    reply_is_thread_fallback = thread_root and relates_to.get("is_falling_back") is True
    result: dict[str, Any] = {}
    if reply_event_id and not reply_is_thread_fallback:
        result["replyTo"] = {"transport": "matrix", "chatId": room_id, "messageId": reply_event_id}
    if isinstance(thread_root, str):
        result["threadTo"] = {"transport": "matrix", "chatId": room_id, "messageId": thread_root}
    return result


def media_attachment(content: dict[str, Any]) -> dict[str, Any] | None:
    msgtype = content.get("msgtype")
    kind = {"m.image": "image", "m.file": "file", "m.audio": "audio", "m.video": "video"}.get(msgtype)
    if not kind:
        return None
    file_info = content.get("file") if isinstance(content.get("file"), dict) else {}
    media_id = content.get("url") or file_info.get("url")
    if not isinstance(media_id, str):
        return None
    info = content.get("info") if isinstance(content.get("info"), dict) else {}
    return compact(
        {
            "mediaId": media_id,
            "kind": kind,
            "fileName": content.get("body") if isinstance(content.get("body"), str) else None,
            "description": content.get("body") if isinstance(content.get("body"), str) else None,
            "mimeType": info.get("mimetype") if isinstance(info.get("mimetype"), str) else None,
            "sizeBytes": info.get("size") if isinstance(info.get("size"), int) else None,
        }
    )


def invite_display_name(event: StateEvent) -> str | None:
    unsigned = serialize(getattr(event, "unsigned", None))
    invite_room_state = unsigned.get("invite_room_state")
    if not isinstance(invite_room_state, list):
        return None
    for event_type, field in (("m.room.name", "name"), ("m.room.canonical_alias", "alias")):
        for state in invite_room_state:
            if not isinstance(state, dict) or state.get("type") != event_type:
                continue
            content = state.get("content") if isinstance(state.get("content"), dict) else {}
            value = content.get(field)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def serialize(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if hasattr(value, "serialize"):
        serialized = value.serialize()
        return serialized if isinstance(serialized, dict) else {}
    return {}


def compact(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None}


def chmod_crypto_files(state_dir: Path) -> None:
    for name in (
        "mautrix-crypto.db",
        "mautrix-crypto.db-wal",
        "mautrix-crypto.db-shm",
        "mautrix-crypto.db-journal",
        "mautrix-state.pickle",
    ):
        path = state_dir / name
        try:
            path.chmod(0o600)
        except FileNotFoundError:
            pass


def now_ms() -> int:
    return int(time.time() * 1000)


def extract_username(user_id: str) -> str:
    return re.sub(r":.*$", "", user_id.removeprefix("@"))


def was_bot_mentioned(text: str, bot_user_id: str) -> bool:
    localpart = extract_username(bot_user_id)
    return bot_user_id in text or bool(localpart and re.search(rf"@{re.escape(localpart)}\b", text, re.I))


def strip_bot_mention(text: str, bot_user_id: str) -> str:
    localpart = extract_username(bot_user_id)
    text = text.replace(bot_user_id, "")
    if localpart:
        text = re.sub(rf"@{re.escape(localpart)}\b", "", text, flags=re.I)
    return text.strip()


if __name__ == "__main__":
    asyncio.run(run())
