#!/usr/bin/env python3
"""Minimal mautrix JSON-lines sidecar for the Matrix transport spike."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

from mautrix.api import Method, Path as MatrixPath
from mautrix.client import Client, InternalEventType, SyncStream
from mautrix.client.encryption_manager import DecryptionDispatcher
from mautrix.client.state_store import FileStateStore
from mautrix.crypto import OlmMachine
from mautrix.crypto.attachments import decrypt_attachment
from mautrix.crypto.store import PgCryptoStateStore, PgCryptoStore
from mautrix.errors.crypto import DecryptionError, SessionNotFound
from mautrix.types import (
    EncryptedEvent,
    EventType,
    Format,
    InReplyTo,
    Membership,
    MessageEvent,
    MessageType,
    PaginationDirection,
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
DEBUG_ROOM_KEYS = os.environ.get("UMG_MATRIX_DEBUG_ROOM_KEYS") == "1"
DEFAULT_MEDIA_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024


def debug_event(event: str, **fields: Any) -> None:
    if not DEBUG_ROOM_KEYS:
        return
    payload = {"event": event, **compact({key: safe_debug_value(value) for key, value in fields.items()})}
    print(f"[umg-mautrix-debug] {json.dumps(payload, sort_keys=True, separators=(',', ':'))}", file=sys.stderr)


def safe_debug_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple, set)):
        return [safe_debug_value(item) for item in value]
    return str(value)


class DiagnosticOlmMachine(OlmMachine):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.client.remove_event_handler(EventType.TO_DEVICE_ENCRYPTED, self.handle_to_device_event)
        self.client.add_event_handler(EventType.TO_DEVICE_ENCRYPTED, self.handle_to_device_event, wait_sync=True)

    async def share_keys(self, current_otk_count: int | None = None) -> None:
        debug_event(
            "device_key_share_start",
            device_id=self.client.device_id,
            account_shared=getattr(self.account, "shared", None),
            current_otk_count=current_otk_count,
        )
        await super().share_keys(current_otk_count)
        debug_event(
            "device_key_share_complete",
            device_id=self.client.device_id,
            account_shared=getattr(self.account, "shared", None),
        )

    async def handle_to_device_event(self, evt: Any) -> None:
        debug_event(
            "to_device_encrypted_received",
            sender=str(getattr(evt, "sender", "")),
            sender_key=str(getattr(getattr(evt, "content", None), "sender_key", "")),
        )
        decrypted_evt = await self._decrypt_olm_event(evt)
        debug_event(
            "to_device_decrypted",
            decrypted_type=str(getattr(decrypted_evt, "type", "")),
            sender=str(getattr(decrypted_evt, "sender", "")),
            sender_device=str(getattr(decrypted_evt, "sender_device", "")),
        )
        if decrypted_evt.type == EventType.ROOM_KEY:
            await self._receive_room_key(decrypted_evt)
        elif decrypted_evt.type == EventType.FORWARDED_ROOM_KEY:
            await self._receive_forwarded_room_key(decrypted_evt)

    async def _receive_room_key(self, evt: Any) -> None:
        content = getattr(evt, "content", None)
        debug_event(
            "room_key_received",
            room_id=str(getattr(content, "room_id", "")),
            session_id=str(getattr(content, "session_id", "")),
            sender=str(getattr(evt, "sender", "")),
            sender_device=str(getattr(evt, "sender_device", "")),
        )
        await super()._receive_room_key(evt)

    async def _receive_forwarded_room_key(self, evt: Any) -> None:
        content = getattr(evt, "content", None)
        debug_event(
            "forwarded_room_key_received",
            room_id=str(getattr(content, "room_id", "")),
            session_id=str(getattr(content, "session_id", "")),
            sender=str(getattr(evt, "sender", "")),
            sender_device=str(getattr(evt, "sender_device", "")),
        )
        await super()._receive_forwarded_room_key(evt)


class Sidecar:
    def __init__(self) -> None:
        self.client: Client | None = None
        self.crypto_db: Database | None = None
        self.crypto_store: PgCryptoStore | None = None
        self.crypto: OlmMachine | None = None
        self.state_store: FileStateStore | None = None
        self.bot_user_id = ""
        self.joined_rooms: set[str] = set()
        self.pending_invites: dict[str, dict[str, Any]] = {}
        self.room_member_count: dict[str, int] = {}
        self.connected_at = 0
        self.state_dir: Path | None = None
        self.media_download_max_bytes = DEFAULT_MEDIA_DOWNLOAD_MAX_BYTES
        self.recovery_key: str | None = None
        self.cross_sign_status: dict[str, Any] = {"enabled": False}

    async def connect(self, command: dict[str, Any]) -> dict[str, Any]:
        state_dir = Path(str(command["stateDir"])).resolve()
        state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        state_dir.chmod(0o700)
        self.state_dir = state_dir
        homeserver_url = str(command["homeserverUrl"])
        access_token = str(command["accessToken"])
        command_recovery_key = command.get("recoveryKey")
        self.recovery_key = str(command_recovery_key).strip() if command_recovery_key else None
        encryption = bool(command.get("encryption", True))
        media_download_max_bytes = command.get("mediaDownloadMaxBytes")
        self.media_download_max_bytes = media_download_max_bytes if isinstance(media_download_max_bytes, int) and media_download_max_bytes >= 0 else DEFAULT_MEDIA_DOWNLOAD_MAX_BYTES

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
            crypto = DiagnosticOlmMachine(client, crypto_store, state_store)
            crypto.share_keys_min_trust = TrustState.UNVERIFIED
            crypto.send_keys_min_trust = TrustState.UNVERIFIED
            client.crypto = crypto
            client.remove_dispatcher(DecryptionDispatcher)
            client.add_event_handler(EventType.ROOM_ENCRYPTED, self.handle_encrypted, wait_sync=True)
            debug_event("olm_load_start", user_id=str(client.mxid), device_id=str(client.device_id))
            await crypto.load()
            debug_event(
                "olm_load_complete",
                user_id=str(client.mxid),
                device_id=str(client.device_id),
                account_shared=getattr(crypto.account, "shared", None),
            )
            if not crypto.account.shared:
                await crypto.share_keys()
            else:
                debug_event("device_keys_already_shared", device_id=str(client.device_id))
            self.crypto_db = crypto_db
            self.crypto_store = crypto_store
            self.crypto = crypto
            self.client = client
            await self.verify_with_recovery_key()

        client.add_event_handler(EventType.ROOM_MESSAGE, self.handle_message)
        client.add_event_handler(EventType.REACTION, self.handle_reaction)
        client.add_event_handler(EventType.ROOM_MEMBER, self.handle_member)
        self.register_debug_handlers(client)
        self.client = client
        self.connected_at = now_ms()
        self.joined_rooms = set(str(room) for room in await client.get_joined_rooms())
        for room_id in list(self.joined_rooms):
            await self.refresh_room_member_count(room_id)
        debug_event("sync_starting", user_id=self.bot_user_id, device_id=str(getattr(client, "device_id", "")))
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
        self.crypto = None
        self.state_store = None
        self.joined_rooms.clear()
        self.pending_invites.clear()
        self.room_member_count.clear()
        self.state_dir = None
        self.media_download_max_bytes = DEFAULT_MEDIA_DOWNLOAD_MAX_BYTES
        self.recovery_key = None
        self.cross_sign_status = {"enabled": False}

    def register_debug_handlers(self, client: Client) -> None:
        if not DEBUG_ROOM_KEYS:
            return
        client.add_event_handler(EventType.ALL, self.handle_to_device_debug, sync_stream=SyncStream.TO_DEVICE)
        client.add_event_handler(EventType.ROOM_KEY_WITHHELD, self.handle_room_key_withheld)
        client.add_event_handler(EventType.ORG_MATRIX_ROOM_KEY_WITHHELD, self.handle_room_key_withheld)
        client.add_event_handler(InternalEventType.SYNC_STARTED, self.handle_sync_started_debug)
        client.add_event_handler(InternalEventType.SYNC_SUCCESSFUL, self.handle_sync_success_debug)
        client.add_event_handler(InternalEventType.DEVICE_OTK_COUNT, self.handle_otk_count_debug)
        client.add_event_handler(InternalEventType.DEVICE_LISTS, self.handle_device_lists_debug)

    async def handle_sync_started_debug(self, _: Any) -> None:
        client = require_client(self.client)
        debug_event("sync_started_callback", user_id=self.bot_user_id, device_id=str(getattr(client, "device_id", "")))

    async def handle_sync_success_debug(self, data: Any) -> None:
        if not isinstance(data, dict):
            debug_event("sync_success_callback")
            return
        debug_event(
            "sync_success_callback",
            is_initial=bool((data.get("net.maunium.mautrix") or {}).get("is_initial")) if isinstance(data.get("net.maunium.mautrix"), dict) else None,
            to_device_events=len((data.get("to_device") or {}).get("events") or []) if isinstance(data.get("to_device"), dict) else 0,
            joined_rooms=len((data.get("rooms") or {}).get("join") or {}) if isinstance(data.get("rooms"), dict) else 0,
            invited_rooms=len((data.get("rooms") or {}).get("invite") or {}) if isinstance(data.get("rooms"), dict) else 0,
        )

    async def handle_otk_count_debug(self, count: Any) -> None:
        debug_event(
            "otk_count_callback",
            curve25519=getattr(count, "curve25519", None),
            signed_curve25519=getattr(count, "signed_curve25519", None),
        )

    async def handle_device_lists_debug(self, device_lists: Any) -> None:
        debug_event(
            "device_lists_callback",
            changed=list(getattr(device_lists, "changed", []) or []),
            left=list(getattr(device_lists, "left", []) or []),
        )

    async def handle_to_device_debug(self, event: Any) -> None:
        content = serialize(getattr(event, "content", None))
        debug_event(
            "to_device_received",
            event_type=str(getattr(event, "type", "")),
            sender=str(getattr(event, "sender", "")),
            code=content.get("code"),
            reason=content.get("reason"),
            room_id=content.get("room_id"),
            session_id=content.get("session_id"),
        )

    async def handle_room_key_withheld(self, event: Any) -> None:
        content = serialize(getattr(event, "content", None))
        debug_event(
            "room_key_withheld",
            sender=str(getattr(event, "sender", "")),
            room_id=content.get("room_id"),
            session_id=content.get("session_id"),
            code=content.get("code"),
            reason=content.get("reason"),
            algorithm=content.get("algorithm"),
        )

    async def handle_encrypted(self, event: EncryptedEvent) -> None:
        try:
            await self.decrypt_and_dispatch(event)
        except SessionNotFound as error:
            room_id = str(event.room_id)
            event_id = str(event.event_id) if event.event_id else None
            content = event.content
            session_id = str(getattr(content, "session_id", "")) or str(error.session_id)
            debug_event(
                "decryption_missing_session",
                room_id=room_id,
                event_id=event_id,
                sender=str(event.sender),
                session_id=session_id,
                device_id=encrypted_content_device_id(content),
            )
            crypto = require_crypto(self.crypto)
            if await crypto.wait_for_session(event.room_id, content.session_id, timeout=3):
                debug_event("decryption_retry_after_room_key", room_id=room_id, event_id=event_id, session_id=session_id)
                await self.decrypt_and_dispatch(event)
                return
            try:
                requested_key = await self.request_missing_room_key(event, timeout=10)
            except Exception as request_error:
                debug_event("room_key_request_failed", room_id=room_id, event_id=event_id, error=str(request_error))
                requested_key = False
            if requested_key:
                debug_event("decryption_retry_after_key_request", room_id=room_id, event_id=event_id, session_id=session_id)
                await self.decrypt_and_dispatch(event)
                return
            await self.emit_decryption_error(event, error)
        except DecryptionError as error:
            await self.emit_decryption_error(event, error)

    async def decrypt_and_dispatch(self, event: EncryptedEvent) -> None:
        client = require_client(self.client)
        crypto = require_crypto(self.crypto)
        decrypted = await crypto.decrypt_megolm_event(event)
        debug_event(
            "decryption_success",
            room_id=str(event.room_id),
            event_id=str(event.event_id) if event.event_id else None,
            decrypted_type=str(getattr(decrypted, "type", "")),
        )
        tasks = client.dispatch_event(decrypted, getattr(event, "source", None))
        if tasks:
            await asyncio.gather(*tasks)

    async def request_missing_room_key(self, event: EncryptedEvent, timeout: int) -> bool:
        crypto = require_crypto(self.crypto)
        content = event.content
        session_id = getattr(content, "session_id", None)
        sender_key = encrypted_content_sender_key(content)
        device_id = encrypted_content_device_id(content)
        if not session_id or not sender_key:
            debug_event(
                "room_key_request_skipped",
                room_id=str(event.room_id),
                event_id=str(event.event_id) if event.event_id else None,
                reason="missing session_id or sender_key",
            )
            return False
        if not device_id:
            try:
                device = await crypto.get_or_fetch_device_by_key(event.sender, sender_key)
                device_id = str(device.device_id) if device else None
            except Exception as error:
                debug_event("room_key_request_device_lookup_failed", error=str(error))
        if not device_id:
            debug_event(
                "room_key_request_skipped",
                room_id=str(event.room_id),
                event_id=str(event.event_id) if event.event_id else None,
                reason="missing sender device",
            )
            return False
        debug_event(
            "room_key_request_send",
            room_id=str(event.room_id),
            event_id=str(event.event_id) if event.event_id else None,
            sender=str(event.sender),
            sender_device=device_id,
            session_id=str(session_id),
        )
        return await crypto.request_room_key(
            event.room_id,
            sender_key,
            session_id,
            {event.sender: {device_id: None}},
            timeout=timeout,
        )

    async def emit_decryption_error(self, event: EncryptedEvent, error: Exception) -> None:
        room_id = str(event.room_id)
        event_id = str(event.event_id) if event.event_id else None
        debug_event(
            "decryption_failed",
            room_id=room_id,
            event_id=event_id,
            sender=str(event.sender),
            error=str(error),
        )
        await emit(
            {
                "type": "error",
                "category": "matrix-decryption",
                "roomId": room_id,
                "eventId": event_id,
                "error": str(error),
            }
        )

    async def verify_with_recovery_key(self) -> None:
        crypto = require_crypto(self.crypto)
        recovery_key = self.recovery_key or read_recovery_key(self.state_dir)
        self.cross_sign_status = await self.cross_sign_diagnostics("before")
        if not recovery_key:
            self.cross_sign_status = {
                **self.cross_sign_status,
                "recoveryKey": "missing",
                "result": "skipped",
                "reason": "matrix-recovery-key.txt not found or unreadable",
            }
            debug_event("cross_sign_skipped", **self.cross_sign_status)
            return
        try:
            debug_event("cross_sign_recovery_import_start", device_id=str(require_client(self.client).device_id))
            await crypto.verify_with_recovery_key(recovery_key)
            self.cross_sign_status = await self.cross_sign_diagnostics("after")
            self.cross_sign_status = {**self.cross_sign_status, "recoveryKey": "present", "result": "imported"}
            debug_event("cross_sign_recovery_import_success", **self.cross_sign_status)
        except Exception as error:
            self.cross_sign_status = await self.cross_sign_diagnostics("after_error")
            self.cross_sign_status = {
                **self.cross_sign_status,
                "recoveryKey": "present",
                "result": "failed",
                "reason": str(error),
            }
            debug_event("cross_sign_recovery_import_failed", **self.cross_sign_status)

    async def cross_sign_diagnostics(self, phase: str) -> dict[str, Any]:
        client = require_client(self.client)
        crypto = require_crypto(self.crypto)
        device_id = str(getattr(client, "device_id", ""))
        diagnostics: dict[str, Any] = {
            "enabled": True,
            "phase": phase,
            "deviceId": device_id,
            "masterKey": False,
            "selfSigningKey": False,
            "userSigningKey": False,
            "deviceSelfSigned": False,
            "ownIdentityTrusted": False,
            "ownDeviceTrust": None,
        }
        try:
            public_keys = await crypto.get_own_cross_signing_public_keys()
            diagnostics["masterKey"] = bool(getattr(public_keys, "master_key", None))
            diagnostics["selfSigningKey"] = bool(getattr(public_keys, "self_signing_key", None))
            diagnostics["userSigningKey"] = bool(getattr(public_keys, "user_signing_key", None))
            diagnostics["ownIdentityTrusted"] = bool(
                diagnostics["masterKey"]
                and diagnostics["selfSigningKey"]
                and diagnostics["userSigningKey"]
                and getattr(crypto, "_cross_signing_private_keys", None)
            )
        except Exception as error:
            diagnostics["publicKeyError"] = str(error)
        try:
            device = await crypto.get_or_fetch_device(client.mxid, client.device_id)
            if device:
                diagnostics["ownDeviceTrust"] = str(await crypto.resolve_trust(device))
        except Exception as error:
            diagnostics["ownDeviceTrustError"] = str(error)
        try:
            response = await client.query_keys({client.mxid: [client.device_id]}, timeout=5000)
            device_keys = response.device_keys.get(client.mxid, {}).get(client.device_id)
            self_signing = response.self_signing_keys.get(client.mxid)
            self_signing_key = first_key_value(getattr(self_signing, "keys", None))
            signatures = getattr(device_keys, "signatures", {}).get(client.mxid, {}) if device_keys else {}
            diagnostics["deviceSelfSigned"] = bool(
                self_signing_key and any(signature_key_matches(key_id, self_signing_key) for key_id in signatures)
            )
        except Exception as error:
            diagnostics["deviceSelfSignedError"] = str(error)
        return diagnostics

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
        cross = self.cross_sign_status
        device_signed = cross.get("deviceSelfSigned") is True
        keys_present = bool(cross.get("masterKey") and cross.get("selfSigningKey") and cross.get("userSigningKey"))
        status = "ready" if device_signed and keys_present else "degraded"
        details = [
            "store: sqlite",
            "sidecar: python mautrix",
            f"device: {cross.get('deviceId') or getattr(self.client, 'device_id', '')}",
            f"recovery key: {cross.get('recoveryKey', 'unknown')}",
            f"cross-sign import: {cross.get('result', 'unknown')}",
            f"cross-signing identity: {'present' if keys_present else 'incomplete'}",
            f"device signature: {'self-signed' if device_signed else 'not self-signed'}",
        ]
        details.append(f"own identity trusted: {'yes' if cross.get('ownIdentityTrusted') else 'no'}")
        if cross.get("ownDeviceTrust"):
            details.append(f"own device trust: {cross.get('ownDeviceTrust')}")
        if cross.get("reason"):
            details.append(f"cross-sign reason: {cross.get('reason')}")
        return [
            {
                "category": "matrix-e2ee",
                "status": status,
                "summary": "mautrix crypto store ready" if status == "ready" else "mautrix crypto ready; cross-signing incomplete",
                "details": details,
            }
        ]

    async def search_history(self, command: dict[str, Any]) -> dict[str, Any]:
        client = require_client(self.client)
        query = str(command.get("query") or "").strip()
        message_id = str(command.get("messageId") or "").strip()
        from_timestamp = optional_int(command.get("fromTimestamp"))
        to_timestamp = optional_int(command.get("toTimestamp"))
        if not query and not message_id and from_timestamp is None and to_timestamp is None:
            return {"messages": [], "scannedChats": 0, "scannedMessages": 0}
        self.joined_rooms = set(str(room) for room in await client.get_joined_rooms())
        requested_rooms = command.get("chatIds")
        rooms = [str(room) for room in requested_rooms if isinstance(room, str)] if isinstance(requested_rooms, list) else sorted(self.joined_rooms)
        rooms = [room for room in rooms if room in self.joined_rooms]
        limit = bounded_int(command.get("limit"), 10, 1, 25)
        max_messages_per_chat = bounded_int(command.get("maxMessagesPerChat"), 100, 1, 1000)
        max_scanned_messages = 2000
        deadline = time.monotonic() + bounded_int(command.get("deadlineMs"), 45_000, 1000, 55_000) / 1000
        terms = search_terms(query)
        matches: list[dict[str, Any]] = []
        errors: list[str] = []
        scanned_messages = 0
        skipped_decryptions = 0
        timed_out = False

        async def collect_event(room_id: str, event: Any) -> str:
            nonlocal scanned_messages, skipped_decryptions
            event_timestamp = history_event_timestamp(event)
            if to_timestamp is not None and event_timestamp > to_timestamp:
                return "too_new"
            if from_timestamp is not None and event_timestamp < from_timestamp:
                return "too_old"
            scanned_messages += 1
            message, skipped_decryption = await self.history_message(room_id, event)
            if skipped_decryption and is_recent_history_event(event):
                skipped_decryptions += 1
            if not message:
                return "skipped"
            score = 1 if not query else search_score(message["content"], query, terms)
            if score <= 0:
                return "skipped"
            message["score"] = score
            matches.append(message)
            return "matched"

        async def scan_paginated(room_id: str, direction: PaginationDirection, token: str | None) -> None:
            nonlocal timed_out
            scanned_room_messages = 0
            room_token = token
            while room_token and scanned_room_messages < max_messages_per_chat and scanned_messages < max_scanned_messages:
                if time.monotonic() >= deadline:
                    timed_out = True
                    errors.append("search returned partial results at deadline")
                    break
                page_limit = min(50, max_messages_per_chat - scanned_room_messages, max_scanned_messages - scanned_messages)
                try:
                    page = await client.get_messages(room_id, direction, room_token, limit=page_limit)
                except Exception as error:
                    errors.append(f"{room_id}: {error}")
                    break
                events = paginated_events(page)
                if not events:
                    break
                for event in events:
                    if time.monotonic() >= deadline:
                        timed_out = True
                        errors.append("search returned partial results at deadline")
                        break
                    status = await collect_event(room_id, event)
                    if status in {"matched", "skipped"}:
                        scanned_room_messages += 1
                    if direction == PaginationDirection.BACKWARD and status == "too_old":
                        return
                    if direction == PaginationDirection.FORWARD and status == "too_new":
                        return
                if timed_out:
                    break
                next_token = paginated_end(page)
                if not next_token or next_token == room_token:
                    break
                room_token = next_token

        async def scan_date_range(room_id: str) -> bool:
            direction = "f" if from_timestamp is not None else "b"
            timestamp = from_timestamp if from_timestamp is not None else to_timestamp
            if timestamp is None:
                return False
            event_id = await self.timestamp_to_event_id(room_id, timestamp, direction)
            if not event_id:
                return False
            try:
                context = await client.get_event_context(room_id, event_id, limit=min(100, max_messages_per_chat))
            except Exception as error:
                errors.append(f"{room_id}: {error}")
                return False
            context_events = [
                *list(getattr(context, "events_before", []) or []),
                getattr(context, "event", None),
                *list(getattr(context, "events_after", []) or []),
            ]
            context_events = [event for event in context_events if event is not None]
            context_events.sort(key=history_event_timestamp, reverse=from_timestamp is None)
            for event in context_events:
                status = await collect_event(room_id, event)
                if from_timestamp is not None and status == "too_new":
                    return
                if from_timestamp is None and status == "too_old":
                    return
            await scan_paginated(
                room_id,
                PaginationDirection.FORWARD if from_timestamp is not None else PaginationDirection.BACKWARD,
                str(getattr(context, "end" if from_timestamp is not None else "start", "") or "") or None,
            )
            return True

        token: str | None = None
        for room_id in rooms:
            if time.monotonic() >= deadline:
                timed_out = True
                errors.append("search returned partial results at deadline")
                break
            if scanned_messages >= max_scanned_messages:
                errors.append(f"search stopped after scanning {max_scanned_messages} messages")
                break
            if message_id:
                try:
                    await collect_event(room_id, await client.get_event(room_id, message_id))
                except Exception as error:
                    errors.append(f"{room_id}: {error}")
                continue
            if from_timestamp is not None or to_timestamp is not None:
                if await scan_date_range(room_id):
                    continue
            token = token or await self.current_sync_token()
            await scan_paginated(room_id, PaginationDirection.BACKWARD, token)
        matches.sort(key=lambda item: (int(item.get("score") or 0), int(item.get("timestamp") or 0)), reverse=True)
        return {
            "messages": [without_score(message) for message in matches[:limit]],
            "scannedChats": len(rooms),
            "scannedMessages": scanned_messages,
            "skippedDecryption": skipped_decryptions,
            "partial": timed_out or scanned_messages >= max_scanned_messages,
            **({"errors": list(dict.fromkeys(errors))[:10]} if errors else {}),
        }

    async def timestamp_to_event_id(self, room_id: str, timestamp: int, direction: str) -> str | None:
        try:
            response = await require_client(self.client).api.request(
                Method.GET,
                MatrixPath.v1.rooms[room_id].timestamp_to_event,
                query_params={"ts": str(timestamp), "dir": direction},
                metrics_method="timestamp_to_event",
            )
        except Exception:
            return None
        event_id = response.get("event_id") if isinstance(response, dict) else None
        return event_id if isinstance(event_id, str) and event_id else None

    async def current_sync_token(self) -> str:
        client = require_client(self.client)
        # Do not call client.sync here; the background sync loop owns /sync.
        for _ in range(20):
            token = await client.sync_store.get_next_batch()
            if isinstance(token, str) and token:
                return token
            await asyncio.sleep(0.1)
        raise RuntimeError("Matrix sync has not produced a pagination token yet")

    async def history_message(self, room_id: str, event: Any) -> tuple[dict[str, Any] | None, bool]:
        event, skipped_decryption = await self.decrypt_history_event(event)
        if not event:
            return None, skipped_decryption
        raw_content = serialize(getattr(event, "content", None))
        if raw_content.get("m.new_content"):
            return None, skipped_decryption
        body = raw_content.get("body")
        if not isinstance(body, str) or not body.strip():
            return None, skipped_decryption
        event_id = str(getattr(event, "event_id", "") or "")
        if not event_id:
            return None, skipped_decryption
        return compact(
            {
                "transport": "matrix",
                "chatId": room_id,
                "messageId": event_id,
                "content": body.strip(),
                "username": extract_username(str(getattr(event, "sender", ""))),
                "userId": str(getattr(event, "sender", "")) or None,
                "timestamp": int(getattr(event, "timestamp", None) or now_ms()),
                "permalink": matrix_permalink(room_id, event_id),
                **message_references(room_id, raw_content),
            }
        ), skipped_decryption

    async def decrypt_history_event(self, event: Any) -> tuple[Any | None, bool]:
        if getattr(event, "type", None) != EventType.ROOM_ENCRYPTED:
            return event, False
        crypto = self.crypto
        if not crypto:
            return None, True
        try:
            return await crypto.decrypt_megolm_event(event), False
        except (SessionNotFound, DecryptionError):
            return None, True
        except Exception:
            return None, True

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
        if attachment:
            attachment["download"] = await self.download_media_attachment(raw_content, attachment, str(event.event_id or ""))
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

    async def download_media_attachment(
        self,
        content: dict[str, Any],
        attachment: dict[str, Any],
        event_id: str,
    ) -> dict[str, Any]:
        max_bytes = self.media_download_max_bytes
        declared_size = attachment.get("sizeBytes")
        if max_bytes <= 0:
            return {"status": "skipped", "error": "media downloads disabled"}
        if isinstance(declared_size, int) and declared_size > max_bytes:
            return {"status": "skipped", "error": f"attachment exceeds {max_bytes} byte limit"}
        try:
            client = require_client(self.client)
            ciphertext = await limited_matrix_download(client, str(attachment["mediaId"]), max_bytes)
            file_info = content.get("file") if isinstance(content.get("file"), dict) else None
            if file_info:
                key_info = file_info.get("key")
                data = decrypt_attachment(
                    ciphertext,
                    key_info.get("k") if isinstance(key_info, dict) else key_info,
                    (file_info.get("hashes") or {}).get("sha256") if isinstance(file_info.get("hashes"), dict) else None,
                    file_info.get("iv"),
                )
            else:
                data = ciphertext
            if len(data) > max_bytes:
                return {"status": "skipped", "error": f"attachment exceeds {max_bytes} byte limit after decrypt"}
            path = media_path(require_state_dir(self.state_dir), attachment, event_id)
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o600)
            return {
                "status": "downloaded",
                "localPath": str(path),
                "sizeBytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        except OversizedMediaError as error:
            return {"status": "skipped", "error": str(error)}
        except Exception as error:
            return {"status": "failed", "error": str(error)}

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
        "search_history": sidecar.search_history,
        "send_message": sidecar.send_message,
        "send_reaction": sidecar.send_reaction,
        "send_typing": sidecar.send_typing,
        "leave_chat": sidecar.leave_chat,
        "accept_invite": sidecar.accept_invite,
        "reject_invite": sidecar.reject_invite,
    }
    tasks: set[asyncio.Task[None]] = set()
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            command = json.loads(line)
            task = asyncio.create_task(handle_command(command, handlers))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await sidecar.disconnect()


async def handle_command(command: dict[str, Any], handlers: dict[str, Any]) -> None:
    command_id = command.get("id")
    try:
        handler = handlers[str(command.get("type"))]
        result = await handler(command)
        await emit({"id": command_id, "ok": True, "result": result})
    except Exception as error:
        await emit({"id": command_id, "ok": False, "error": str(error)})


async def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class OversizedMediaError(Exception):
    pass


async def limited_matrix_download(client: Client, media_id: str, max_bytes: int) -> bytes:
    try:
        url = client.api.get_download_url(media_id, authenticated=True)
    except TypeError:
        url = client.api.get_download_url(media_id)
    data = bytearray()
    headers = {"Authorization": f"Bearer {client.api.token}"}
    async with client.api.session.get(url, headers=headers) as response:
        response.raise_for_status()
        async for chunk in response.content.iter_chunked(65536):
            data.extend(chunk)
            if len(data) > max_bytes:
                raise OversizedMediaError(f"attachment exceeds {max_bytes} byte limit")
    return bytes(data)


def require_state_dir(state_dir: Path | None) -> Path:
    if not state_dir:
        raise RuntimeError("Matrix state directory is not configured")
    return state_dir


def media_path(state_dir: Path, attachment: dict[str, Any], event_id: str) -> Path:
    digest = hashlib.sha256(f"{event_id}\0{attachment.get('mediaId', '')}".encode("utf8")).hexdigest()
    file_name = safe_file_name(str(attachment.get("fileName") or attachment.get("description") or "attachment"))
    return state_dir / "media" / f"{digest[:16]}-{file_name}"


def safe_file_name(value: str) -> str:
    name = Path(value).name.strip() or "attachment"
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip(" .") or "attachment"
    return name[:120]


def read_recovery_key(state_dir: Path | None) -> str | None:
    return read_secret(
        "UNIVERSAL_MESSENGER_GATEWAY_MATRIX_RECOVERY_KEY",
        "UNIVERSAL_MESSENGER_GATEWAY_MATRIX_RECOVERY_KEY_FILE",
        state_dir / "matrix-recovery-key.txt" if state_dir else None,
        "recovery key",
    )


def read_secret(env_var: str, file_env_var: str, default_path: Path | None, label: str) -> str | None:
    direct = os.environ.get(env_var)
    if direct and direct.strip():
        return direct.strip()
    path_value = os.environ.get(file_env_var)
    path = Path(path_value) if path_value else default_path
    if not path:
        return None
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    except Exception as error:
        debug_event("secret_read_failed", label=label, error=str(error))
        return None
    if stat.st_mode & 0o077:
        debug_event("secret_read_skipped", label=label, reason="insecure permissions", mode=oct(stat.st_mode & 0o777))
        return None
    try:
        return path.read_text(encoding="utf8").strip() or None
    except Exception as error:
        debug_event("secret_read_failed", label=label, error=str(error))
        return None


def first_key_value(keys: Any) -> str | None:
    if not isinstance(keys, dict) or not keys:
        return None
    value = next(iter(keys.values()))
    return str(value) if value else None


def signature_key_matches(key_id: Any, signing_key: str) -> bool:
    key = getattr(key_id, "key_id", None)
    return str(key or key_id).removeprefix("ed25519:") == signing_key


def require_client(client: Client | None) -> Client:
    if not client:
        raise RuntimeError("Matrix client not connected")
    return client


def require_crypto(crypto: OlmMachine | None) -> OlmMachine:
    if not crypto:
        raise RuntimeError("Matrix crypto not connected")
    return crypto


def encrypted_content_sender_key(content: Any) -> Any:
    return getattr(content, "_sender_key", None)


def encrypted_content_device_id(content: Any) -> str | None:
    device_id = getattr(content, "_device_id", None)
    return str(device_id) if device_id else None


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


def paginated_events(page: Any) -> list[Any]:
    events = getattr(page, "events", None)
    if isinstance(events, list):
        return events
    chunk = getattr(page, "chunk", None)
    if isinstance(chunk, list):
        return chunk
    if isinstance(page, (list, tuple)) and len(page) >= 3 and isinstance(page[2], list):
        return page[2]
    return []


def paginated_end(page: Any) -> str | None:
    value = getattr(page, "end", None)
    if isinstance(value, str):
        return value
    if isinstance(page, (list, tuple)) and len(page) >= 2 and isinstance(page[1], str):
        return page[1]
    return None


def optional_int(value: Any) -> int | None:
    return value if isinstance(value, int) else None


def history_event_timestamp(event: Any) -> int:
    timestamp = getattr(event, "timestamp", None)
    return timestamp if isinstance(timestamp, int) else now_ms()


def search_terms(query: str) -> list[str]:
    return [term for term in re.findall(r"[\w@:.#$!/-]+", query.lower()) if len(term) > 1]


def search_score(text: str, query: str, terms: list[str]) -> int:
    haystack = text.lower()
    phrase = query.lower().strip()
    score = 10 if phrase and phrase in haystack else 0
    for term in terms:
        if term in haystack:
            score += 1 + haystack.count(term)
    return score


def without_score(message: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in message.items() if key != "score"}


def bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    if not isinstance(value, int):
        return default
    return max(minimum, min(maximum, value))


def matrix_permalink(room_id: str, event_id: str) -> str:
    return f"https://matrix.to/#/{quote(room_id, safe='')}/{quote(event_id, safe='')}"


def is_recent_history_event(event: Any) -> bool:
    timestamp = getattr(event, "timestamp", None)
    return isinstance(timestamp, int) and timestamp >= now_ms() - 24 * 60 * 60 * 1000


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
