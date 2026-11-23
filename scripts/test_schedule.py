#!/usr/bin/env python3
"""scripts/schedule.py：DUTY（duty_default）の予定時刻と取りこぼし・再試行。"""
import datetime as dt
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import schedule

JST = dt.timezone(dt.timedelta(hours=9))
UTC = dt.timezone.utc


def jst(y, m, d, H, M, S=0):
    return dt.datetime(y, m, d, H, M, S, tzinfo=JST).astimezone(UTC)


def iso(t):
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class TestDutyDefaultSchedule(unittest.TestCase):
    def setUp(self):
        self.assertEqual(schedule.SCHEDULE["duty_default"], [(0, 0), (5, 0)])

    def test_slots_0000_and_0500(self):
        slots = schedule.SCHEDULE["duty_default"]
        day = dt.date(2026, 11, 24)
        times = list(schedule._slot_times(day, slots))
        self.assertEqual(times, [
            dt.datetime(2026, 11, 24, 0, 0, tzinfo=JST),
            dt.datetime(2026, 11, 24, 5, 0, tzinfo=JST),
        ])

    def test_routine_0002_is_due_once_until_0500(self):
        """00:00 以降の最初のルーティン枠（00:02）で due。成功後は 05:00 前まで due にならない。"""
        yesterday_ok = {"duty_default": {"okAt": iso(jst(2026, 11, 23, 5, 2))}}
        at_0002 = jst(2026, 11, 24, 0, 2)
        self.assertTrue(schedule.is_due("duty_default", yesterday_ok, at_0002))
        after = {"duty_default": {"okAt": iso(at_0002), "tryAt": iso(at_0002)}}
        for H, M in ((0, 17), (0, 32), (0, 47), (1, 2), (4, 47)):
            self.assertFalse(
                schedule.is_due("duty_default", after, jst(2026, 11, 24, H, M)),
                f"should not be due at {H:02d}:{M:02d} after 00:02 success",
            )
        # 05:00 ちょうど／05:02 は再確認のため due
        self.assertTrue(schedule.is_due("duty_default", after, jst(2026, 11, 24, 5, 0)))
        self.assertTrue(schedule.is_due("duty_default", after, jst(2026, 11, 24, 5, 2)))

    def test_routine_0502_is_due_once(self):
        """05:00 以降の最初のルーティン枠（05:02）で due。成功後は同日の以降の枠では due にならない。"""
        after_midnight = {"duty_default": {"okAt": iso(jst(2026, 11, 24, 0, 2)), "tryAt": iso(jst(2026, 11, 24, 0, 2))}}
        at_0502 = jst(2026, 11, 24, 5, 2)
        self.assertTrue(schedule.is_due("duty_default", after_midnight, at_0502))
        after = {"duty_default": {"okAt": iso(at_0502), "tryAt": iso(at_0502)}}
        for H, M in ((5, 17), (5, 32), (12, 2), (23, 47)):
            self.assertFalse(
                schedule.is_due("duty_default", after, jst(2026, 11, 24, H, M)),
                f"should not be due at {H:02d}:{M:02d} after 05:02 success",
            )

    def test_not_due_before_midnight_if_0502_succeeded(self):
        """前日 05:02 が成功していれば、23:47 は due ではない。"""
        st = {"duty_default": {"okAt": iso(jst(2026, 11, 23, 5, 2))}}
        self.assertFalse(schedule.is_due("duty_default", st, jst(2026, 11, 23, 23, 47)))
        self.assertTrue(schedule.is_due("duty_default", st, jst(2026, 11, 24, 0, 0)))

    def test_missed_0002_caught_up_at_0017(self):
        """00:02 を取りこぼしても、次の 00:17 で追いつく。追いついたら 05:00 まで再実行しない。"""
        st = {"duty_default": {"okAt": iso(jst(2026, 11, 23, 5, 2))}}
        self.assertTrue(schedule.is_due("duty_default", st, jst(2026, 11, 24, 0, 17)))
        self.assertTrue(schedule.is_due("duty_default", st, jst(2026, 11, 24, 4, 2)))
        caught = {"duty_default": {"okAt": iso(jst(2026, 11, 24, 0, 17)), "tryAt": iso(jst(2026, 11, 24, 0, 17))}}
        self.assertFalse(schedule.is_due("duty_default", caught, jst(2026, 11, 24, 0, 32)))
        self.assertFalse(schedule.is_due("duty_default", caught, jst(2026, 11, 24, 4, 47)))
        self.assertTrue(schedule.is_due("duty_default", caught, jst(2026, 11, 24, 5, 2)))

    def test_missed_0502_caught_up_at_0517(self):
        """05:02 を取りこぼしても、次の 05:17 で追いつく。"""
        st = {"duty_default": {"okAt": iso(jst(2026, 11, 24, 0, 2)), "tryAt": iso(jst(2026, 11, 24, 0, 2))}}
        self.assertTrue(schedule.is_due("duty_default", st, jst(2026, 11, 24, 5, 17)))
        caught = {"duty_default": {"okAt": iso(jst(2026, 11, 24, 5, 17)), "tryAt": iso(jst(2026, 11, 24, 5, 17))}}
        self.assertFalse(schedule.is_due("duty_default", caught, jst(2026, 11, 24, 5, 32)))
        self.assertFalse(schedule.is_due("duty_default", caught, jst(2026, 11, 24, 12, 2)))

    def test_retry_60_min_after_failure(self):
        """00:02 で失敗したら 60 分は再試行しない。01:02 の枠で再試行。05:02 失敗も同様に 06:02。"""
        tried = jst(2026, 11, 24, 0, 2)
        st = {"duty_default": {"tryAt": iso(tried), "okAt": iso(jst(2026, 11, 23, 5, 2))}}
        self.assertFalse(schedule.is_due("duty_default", st, jst(2026, 11, 24, 0, 17)))
        self.assertFalse(schedule.is_due("duty_default", st, jst(2026, 11, 24, 1, 1)))
        self.assertTrue(schedule.is_due("duty_default", st, jst(2026, 11, 24, 1, 2)))

        tried5 = jst(2026, 11, 24, 5, 2)
        st5 = {"duty_default": {"tryAt": iso(tried5), "okAt": iso(jst(2026, 11, 24, 0, 2))}}
        self.assertFalse(schedule.is_due("duty_default", st5, jst(2026, 11, 24, 5, 17)))
        self.assertTrue(schedule.is_due("duty_default", st5, jst(2026, 11, 24, 6, 2)))

    def test_next_day_0002_due_again(self):
        st = {"duty_default": {"okAt": iso(jst(2026, 11, 24, 5, 2)), "tryAt": iso(jst(2026, 11, 24, 5, 2))}}
        self.assertFalse(schedule.is_due("duty_default", st, jst(2026, 11, 24, 23, 47)))
        self.assertTrue(schedule.is_due("duty_default", st, jst(2026, 11, 25, 0, 2)))

    def test_describe_next_is_0000_or_0500(self):
        d = schedule.describe({}, jst(2026, 11, 24, 0, 1))
        self.assertEqual(d["duty_default"], "05:00")
        d = schedule.describe({}, jst(2026, 11, 23, 23, 0))
        self.assertEqual(d["duty_default"], "00:00")
        d = schedule.describe({}, jst(2026, 11, 24, 5, 1))
        self.assertEqual(d["duty_default"], "00:00")  # 翌日
        nx = schedule.next_slot(jst(2026, 11, 24, 5, 1), schedule.SCHEDULE["duty_default"])
        self.assertEqual(nx, dt.datetime(2026, 11, 25, 0, 0, tzinfo=JST))

    def test_record_roundtrip_state_file(self):
        fd, path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        old = schedule.STATE_FILE
        try:
            schedule.STATE_FILE = path
            now = jst(2026, 11, 24, 0, 2)
            schedule.record("duty_default", True, now)
            st = schedule.load()
            self.assertEqual(st["duty_default"]["okAt"], iso(now))
            self.assertFalse(schedule.is_due("duty_default", st, jst(2026, 11, 24, 0, 17)))
            self.assertTrue(schedule.is_due("duty_default", st, jst(2026, 11, 24, 5, 2)))
        finally:
            schedule.STATE_FILE = old
            try:
                os.remove(path)
            except OSError:
                pass


if __name__ == "__main__":
    unittest.main()
