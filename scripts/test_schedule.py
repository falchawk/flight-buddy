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
        # テスト間で STATE_FILE を触らない。状態は引数で渡す。
        self.assertEqual(schedule.SCHEDULE["duty_default"], [(2, 0)])

    def test_slots_only_0200(self):
        slots = schedule.SCHEDULE["duty_default"]
        day = dt.date(2026, 11, 24)
        times = list(schedule._slot_times(day, slots))
        self.assertEqual(len(times), 1)
        self.assertEqual(times[0], dt.datetime(2026, 11, 24, 2, 0, tzinfo=JST))

    def test_routine_0202_is_due_once(self):
        """02:00 以降の最初のルーティン枠（02:02）で due。成功後は同日の以降の枠では due にならない。"""
        yesterday_ok = {"duty_default": {"okAt": iso(jst(2026, 11, 23, 2, 2))}}
        at_0202 = jst(2026, 11, 24, 2, 2)
        self.assertTrue(schedule.is_due("duty_default", yesterday_ok, at_0202))
        after = {"duty_default": {"okAt": iso(at_0202), "tryAt": iso(at_0202)}}
        for H, M in ((2, 17), (2, 32), (2, 47), (5, 2), (12, 2), (23, 47)):
            self.assertFalse(
                schedule.is_due("duty_default", after, jst(2026, 11, 24, H, M)),
                f"should not be due at {H:02d}:{M:02d} after 02:02 success",
            )

    def test_not_due_before_0200(self):
        """00:02 や 01:47 は、前日 02:02 が成功していれば due ではない。"""
        st = {"duty_default": {"okAt": iso(jst(2026, 11, 23, 2, 2))}}
        self.assertFalse(schedule.is_due("duty_default", st, jst(2026, 11, 24, 0, 2)))
        self.assertFalse(schedule.is_due("duty_default", st, jst(2026, 11, 24, 1, 47)))
        # 02:00 ちょうどは latest_slot に届くので due
        self.assertTrue(schedule.is_due("duty_default", st, jst(2026, 11, 24, 2, 0)))

    def test_missed_0202_caught_up_at_0217(self):
        """02:02 を取りこぼしても、次の 02:17（以降の15分枠）で追いつく。"""
        st = {"duty_default": {"okAt": iso(jst(2026, 11, 23, 2, 2))}}
        self.assertTrue(schedule.is_due("duty_default", st, jst(2026, 11, 24, 2, 17)))
        self.assertTrue(schedule.is_due("duty_default", st, jst(2026, 11, 24, 10, 2)))
        # 追いついたら同日は再実行しない
        caught = {"duty_default": {"okAt": iso(jst(2026, 11, 24, 2, 17)), "tryAt": iso(jst(2026, 11, 24, 2, 17))}}
        self.assertFalse(schedule.is_due("duty_default", caught, jst(2026, 11, 24, 2, 32)))
        self.assertFalse(schedule.is_due("duty_default", caught, jst(2026, 11, 24, 5, 2)))

    def test_retry_60_min_after_failure(self):
        """02:02 で失敗したら 60 分は再試行しない。03:02 の枠で再試行。"""
        tried = jst(2026, 11, 24, 2, 2)
        st = {"duty_default": {"tryAt": iso(tried), "okAt": iso(jst(2026, 11, 23, 2, 2))}}
        self.assertFalse(schedule.is_due("duty_default", st, jst(2026, 11, 24, 2, 17)))
        self.assertFalse(schedule.is_due("duty_default", st, jst(2026, 11, 24, 3, 1)))
        self.assertTrue(schedule.is_due("duty_default", st, jst(2026, 11, 24, 3, 2)))

    def test_next_day_0202_due_again(self):
        st = {"duty_default": {"okAt": iso(jst(2026, 11, 24, 2, 2)), "tryAt": iso(jst(2026, 11, 24, 2, 2))}}
        self.assertFalse(schedule.is_due("duty_default", st, jst(2026, 11, 25, 0, 2)))
        self.assertTrue(schedule.is_due("duty_default", st, jst(2026, 11, 25, 2, 2)))

    def test_describe_next_is_0200(self):
        # 01:00 JST なら次は今日 02:00、03:00 JST なら次は翌日 02:00
        d = schedule.describe({}, jst(2026, 11, 24, 1, 0))
        self.assertEqual(d["duty_default"], "02:00")
        d = schedule.describe({}, jst(2026, 11, 24, 3, 0))
        self.assertEqual(d["duty_default"], "02:00")
        nx = schedule.next_slot(jst(2026, 11, 24, 3, 0), schedule.SCHEDULE["duty_default"])
        self.assertEqual(nx, dt.datetime(2026, 11, 25, 2, 0, tzinfo=JST))

    def test_record_roundtrip_state_file(self):
        fd, path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        old = schedule.STATE_FILE
        try:
            schedule.STATE_FILE = path
            now = jst(2026, 11, 24, 2, 2)
            schedule.record("duty_default", True, now)
            st = schedule.load()
            self.assertEqual(st["duty_default"]["okAt"], iso(now))
            self.assertFalse(schedule.is_due("duty_default", st, jst(2026, 11, 24, 2, 17)))
        finally:
            schedule.STATE_FILE = old
            try:
                os.remove(path)
            except OSError:
                pass


if __name__ == "__main__":
    unittest.main()
