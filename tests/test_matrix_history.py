"""Run with the mautrix environment: python -m unittest discover -s tests -p 'test_*.py'."""

import asyncio
import base64
import importlib.util
import json
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote

from mautrix.errors import MNotFound
from mautrix.types import EventType, PaginationDirection

spec = importlib.util.spec_from_file_location(
    "matrix_sidecar", Path(__file__).parents[1] / "src/transports/matrix-mautrix-sidecar.py"
)
sidecar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidecar)


def event(index, body="needle", timestamp=None, encrypted=False):
    return SimpleNamespace(
        event_id=f"${index}", timestamp=timestamp if timestamp is not None else index + 1,
        sender="@user:example.org", content={"body": body, "msgtype": "m.text"},
        type=EventType.ROOM_ENCRYPTED if encrypted else EventType.ROOM_MESSAGE,
    )


def raw_event(item, room):
    content = item.content if item.type != EventType.ROOM_ENCRYPTED else {
        "algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "encrypted",
        "session_id": "session", "sender_key": "sender", "device_id": "device",
    }
    return {
        "event_id": item.event_id, "room_id": room, "sender": item.sender,
        "origin_server_ts": item.timestamp, "type": str(item.type), "content": content,
        **({"state_key": ""} if item.type == EventType.ROOM_TOPIC else {}),
    }


class FakeClient:
    def __init__(self, rooms):
        self.rooms = rooms
        self.joined = list(rooms)
        self.calls = []
        self.empty_chunk = False
        self.fail_token = None
        self.delay_token = None
        self.membership_delay = 0
        self.api = self

    async def get_joined_rooms(self):
        await asyncio.sleep(self.membership_delay)
        return self.joined

    async def get_messages(self, room, direction, token, limit):
        self.calls.append((room, direction, token, limit))
        if self.fail_token == token and token is not None:
            raise RuntimeError("pagination failed")
        if self.delay_token == token and token is not None:
            await asyncio.sleep(10)
        events = self.rooms[room]
        forward = direction == PaginationDirection.FORWARD
        if self.empty_chunk and token is None:
            return SimpleNamespace(start="empty", end="0" if forward else str(len(events)), chunk=[])
        start = int(token) if token is not None else (0 if forward else len(events))
        end = min(len(events), start + limit) if forward else max(0, start - limit)
        chunk = events[start:end] if forward else list(reversed(events[end:start]))
        return SimpleNamespace(start=str(start), end=str(end) if 0 < end < len(events) else None, chunk=chunk)

    async def get_event(self, room, message_id):
        self.calls.append(("event", room, message_id))
        for item in self.rooms[room]:
            if item.event_id == message_id:
                return item
        raise MNotFound("unknown event")

    async def request(self, method, path, query_params, metrics_method):
        room = unquote(str(path).split("/rooms/")[1].split("/")[0])
        events = self.rooms[room]
        if metrics_method == "history_messages":
            page = await self.get_messages(room, PaginationDirection(query_params["dir"]), query_params.get("from"), int(query_params["limit"]))
            return {"start": page.start, "chunk": [raw_event(item, room) for item in page.chunk],
                    **({"end": page.end} if page.end is not None else {})}
        if metrics_method == "history_context":
            event_id = unquote(str(path).rsplit("/", 1)[1])
            index = next(i for i, item in enumerate(events) if item.event_id == event_id)
            item = events[index]
            self.calls.append(("context", event_id, query_params["limit"]))
            # Real servers may omit events_before/events_after when limit=0.
            return {"start": str(index), "end": str(index + 1), "event": raw_event(item, room)}
        self.calls.append(("seek", query_params))
        ts = int(query_params["ts"])
        candidates = [item for item in events if item.timestamp >= ts] if query_params["dir"] == "f" else [item for item in reversed(events) if item.timestamp <= ts]
        return {"event_id": candidates[0].event_id} if candidates else {}


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    def make_sidecar(self, rooms):
        instance = sidecar.Sidecar.__new__(sidecar.Sidecar)
        instance.client = FakeClient(rooms)
        instance.crypto = None
        return instance

    async def traverse(self, instance, command):
        messages, results = [], []
        for _ in range(100):
            result = await instance.search_history(command)
            results.append(result)
            messages.extend(result["messages"])
            self.assertNotIn("partial", result)
            if not result["hasMore"]:
                self.assertEqual(result["stopReason"], "exhausted")
                self.assertIsNone(result["nextCursor"])
                return messages, results
            self.assertIsNotNone(result["nextCursor"])
            command = {**command, "cursor": result["nextCursor"]}
        self.fail("history traversal did not terminate")

    async def test_over_100_events_and_same_timestamp_native_order(self):
        events = [event(i, timestamp=42) for i in range(237)]
        instance = self.make_sidecar({"!a": events})
        messages, results = await self.traverse(instance, {"query": "needle", "limit": 17})
        self.assertEqual([message["messageId"] for message in messages], [item.event_id for item in reversed(events)])
        self.assertEqual(sum(result["scannedMessages"] for result in results), 237)
        self.assertEqual(results[0]["stopReason"], "page_limit")
        self.assertEqual(results[-1]["completedChats"], 1)

    async def test_no_match_pages_scan_limit_then_match(self):
        events = [event(0)] + [event(i, "other") for i in range(1, 151)]
        instance = self.make_sidecar({"!a": events})
        messages, results = await self.traverse(instance, {"query": "needle"})
        self.assertEqual(results[0]["stopReason"], "scan_limit")
        self.assertEqual(results[0]["messages"], [])
        self.assertEqual(results[0]["scannedMessages"], 100)
        self.assertNotIn("errors", results[0])
        self.assertEqual([message["messageId"] for message in messages], ["$0"])

    async def test_all_room_snapshot_and_coverage(self):
        instance = self.make_sidecar({"!a": [event(1)], "!b": [event(2), event(3)]})
        command = {"query": "needle", "limit": 1}
        first = await instance.search_history(command)
        self.assertEqual((first["totalChats"], first["completedChats"], first["scannedChats"]), (2, 1, 1))
        instance.client.rooms["!c"] = [event(4)]
        instance.client.joined.append("!c")
        messages, results = await self.traverse(instance, {**command, "cursor": first["nextCursor"]})
        self.assertEqual([message["messageId"] for message in messages], ["$3", "$2"])
        self.assertEqual((results[-1]["totalChats"], results[-1]["completedChats"]), (2, 2))

    async def test_membership_loss_returns_retry_not_exhaustion(self):
        instance = self.make_sidecar({"!a": [event(i) for i in range(3)]})
        command = {"query": "needle", "limit": 1}
        first = await instance.search_history(command)
        instance.client.joined = []
        failed = await instance.search_history({**command, "cursor": first["nextCursor"]})
        self.assertEqual(failed["stopReason"], "error")
        self.assertTrue(failed["hasMore"])
        self.assertEqual(first["nextCursor"], failed["nextCursor"])
        instance.client.joined = ["!a"]
        messages, _ = await self.traverse(instance, {**command, "cursor": failed["nextCursor"]})
        self.assertEqual(len(messages), 2)

    async def test_forward_starts_at_room_beginning(self):
        instance = self.make_sidecar({"!a": [event(i) for i in range(5)]})
        messages, _ = await self.traverse(instance, {"chatIds": ["!a"], "direction": "forward", "limit": 2})
        self.assertEqual([message["messageId"] for message in messages], [f"${i}" for i in range(5)])
        self.assertEqual(instance.client.calls[0][1:3], (PaginationDirection.FORWARD, None))

    async def test_date_seek_obeys_direction_includes_anchor(self):
        for direction, expected, seek_direction in [("forward", ["$3", "$4", "$5", "$6"], "f"), ("backward", ["$6", "$5", "$4", "$3"], "b")]:
            with self.subTest(direction=direction):
                instance = self.make_sidecar({"!a": [event(i) for i in range(10)]})
                messages, _ = await self.traverse(instance, {"chatIds": ["!a"], "direction": direction, "fromTimestamp": 4, "toTimestamp": 7, "limit": 2})
                self.assertEqual([message["messageId"] for message in messages], expected)
                seeks = [call for call in instance.client.calls if call[0] == "seek"]
                self.assertEqual(len(seeks), 1)
                self.assertEqual(seeks[0][1]["dir"], seek_direction)

    async def test_date_filter_does_not_stop_at_out_of_order_timestamps(self):
        instance = self.make_sidecar({"!a": [event(0, timestamp=3), event(1, timestamp=12), event(2, timestamp=4), event(3, timestamp=5)]})
        messages, results = await self.traverse(instance, {"chatIds": ["!a"], "fromTimestamp": 3, "toTimestamp": 6, "limit": 1})
        self.assertEqual([message["messageId"] for message in messages], ["$3", "$2", "$0"])
        self.assertEqual(sum(result["scannedMessages"] for result in results), 4)

    async def test_out_of_range_events_consume_budget(self):
        instance = self.make_sidecar({"!a": [event(i) for i in range(150)]})
        first = await instance.search_history({"chatIds": ["!a"], "fromTimestamp": 200})
        self.assertEqual(first["scannedMessages"], 100)
        self.assertEqual(first["stopReason"], "scan_limit")

    async def test_empty_server_chunk_with_advancing_end(self):
        instance = self.make_sidecar({"!a": [event(1)]})
        instance.client.empty_chunk = True
        messages, results = await self.traverse(instance, {"query": "needle"})
        self.assertEqual(len(messages), 1)
        self.assertEqual(results[0]["stopReason"], "exhausted")
        self.assertEqual(len(instance.client.calls), 2)

    async def test_empty_terminal_room(self):
        instance = self.make_sidecar({"!a": []})
        result = await instance.search_history({"query": "needle"})
        self.assertEqual(result["stopReason"], "exhausted")
        self.assertEqual(result["completedChats"], 1)
        self.assertFalse(result["hasMore"])

    async def test_result_and_scan_limits_do_not_drop_in_page_events(self):
        instance = self.make_sidecar({"!a": [event(i) for i in range(121)]})
        messages, results = await self.traverse(instance, {"query": "needle", "limit": 100, "maxMessagesPerChat": 13})
        self.assertEqual(len(messages), 121)
        self.assertEqual(len({message["messageId"] for message in messages}), 121)
        self.assertEqual(results[0]["scannedMessages"], 13)
        self.assertTrue(all(call[-1] == 50 for call in instance.client.calls))

    async def test_state_events_consume_scan_budget(self):
        events = [event(i, "") for i in range(101)]
        for item in events:
            item.type = EventType.ROOM_TOPIC
        instance = self.make_sidecar({"!a": events})
        result = await instance.search_history({"query": "needle"})
        self.assertEqual(result["scannedMessages"], 100)
        self.assertEqual(result["stopReason"], "scan_limit")
        self.assertEqual(result["messages"], [])

    async def test_global_scan_budget(self):
        instance = self.make_sidecar({f"!{room}": [event(i, "other") for i in range(50)] for room in range(41)})
        result = await instance.search_history({"query": "needle"})
        self.assertEqual((result["scannedMessages"], result["completedChats"]), (2000, 40))
        self.assertEqual(result["stopReason"], "scan_limit")
        final = await instance.search_history({"query": "needle", "cursor": result["nextCursor"]})
        self.assertEqual((final["scannedMessages"], final["completedChats"]), (50, 41))
        self.assertEqual(final["stopReason"], "exhausted")

    async def test_exact_lookup_avoids_pagination_and_missing_other_rooms(self):
        instance = self.make_sidecar({"!a": [], "!b": [event(9)]})
        result = await instance.search_history({"messageId": "$9"})
        self.assertEqual([message["messageId"] for message in result["messages"]], ["$9"])
        self.assertEqual(result["scannedMessages"], 1)
        self.assertEqual(result["completedChats"], 2)
        self.assertTrue(all(call[0] == "event" for call in instance.client.calls))

    async def test_all_undecryptable_events_count_including_old(self):
        instance = self.make_sidecar({"!a": [event(0, encrypted=True), event(1, encrypted=True, timestamp=sidecar.now_ms()), event(2)]})
        result = await instance.search_history({"query": "needle"})
        self.assertEqual(result["skippedDecryption"], 2)
        self.assertEqual(result["scannedMessages"], 3)
        self.assertEqual(len(result["messages"]), 1)
        self.assertEqual(result["stopReason"], "exhausted")

    async def test_pagination_error_and_deadline_preserve_retry_token(self):
        for mode in ["fail_token", "delay_token"]:
            with self.subTest(mode=mode):
                instance = self.make_sidecar({"!a": [event(i) for i in range(75)]})
                setattr(instance.client, mode, "25")
                command = {"query": "needle", "limit": 100, "deadlineMs": 1000}
                start = time.monotonic()
                first = await instance.search_history(command)
                self.assertLess(time.monotonic() - start, 2)
                self.assertEqual(first["stopReason"], "error" if mode == "fail_token" else "deadline")
                self.assertEqual("errors" in first, mode == "fail_token")
                self.assertEqual(len(first["messages"]), 50)
                setattr(instance.client, mode, None)
                rest, _ = await self.traverse(instance, {**command, "cursor": first["nextCursor"]})
                self.assertEqual(len(first["messages"] + rest), 75)
                self.assertEqual(rest[0]["messageId"], "$24")

    async def test_request_timeout_is_an_error_not_search_deadline(self):
        instance = self.make_sidecar({"!a": [event(1)]})

        async def timed_out(*args, **kwargs):
            raise TimeoutError("server timed out")

        instance.client.get_messages = timed_out
        result = await instance.search_history({"query": "needle"})
        self.assertEqual(result["stopReason"], "error")
        self.assertIn("server timed out", result["errors"][0])
        self.assertTrue(result["hasMore"])

    async def test_membership_deadline_has_resumable_cursor(self):
        instance = self.make_sidecar({"!a": [event(1)]})
        instance.client.membership_delay = 10
        result = await instance.search_history({"query": "needle", "deadlineMs": 1000})
        self.assertEqual(result["stopReason"], "deadline")
        self.assertEqual(result["scannedMessages"], 0)
        instance.client.membership_delay = 0
        messages, _ = await self.traverse(instance, {"query": "needle", "cursor": result["nextCursor"]})
        self.assertEqual(len(messages), 1)

    async def test_decryption_deadline_retries_unprocessed_event_without_key_requests(self):
        class Crypto:
            async def decrypt_megolm_event(self, item):
                await asyncio.sleep(10)

        instance = self.make_sidecar({"!a": [event(0, encrypted=True), event(1)]})
        instance.crypto = Crypto()
        first = await instance.search_history({"query": "needle", "deadlineMs": 1000})
        self.assertEqual(first["stopReason"], "deadline")
        self.assertEqual([message["messageId"] for message in first["messages"]], ["$1"])
        instance.crypto = None
        final = await instance.search_history({"query": "needle", "cursor": first["nextCursor"]})
        self.assertEqual(final["skippedDecryption"], 1)
        self.assertEqual(final["stopReason"], "exhausted")

    async def test_invalid_and_mismatched_cursors(self):
        instance = self.make_sidecar({"!a": [event(i) for i in range(3)]})
        command = {"query": "needle", "chatIds": ["!a"], "limit": 1}
        first = await instance.search_history(command)
        for value in ["", "123:$id", "not base64", 123, base64.b64encode(b"{}").decode()]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                await instance.search_history({**command, "cursor": value})
        for changes in [{"query": "other"}, {"chatIds": []}, {"direction": "forward"}, {"fromTimestamp": 1}, {"toTimestamp": 9}, {"messageId": "$1"}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                await instance.search_history({**command, **changes, "cursor": first["nextCursor"]})
        state = json.loads(base64.urlsafe_b64decode(first["nextCursor"]))
        for changes in [{"offset": -1}, {"room": 99}, {"rooms": "!a"}, {"rooms": ["!b"]}, {"token": []}, {"initialized": 1}]:
            cursor = base64.urlsafe_b64encode(json.dumps({**state, **changes}).encode()).decode()
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                await instance.search_history({**command, "cursor": cursor})


if __name__ == "__main__":
    unittest.main()
