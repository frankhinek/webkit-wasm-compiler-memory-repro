#!/usr/bin/env python3
"""Sample a process's physical footprint with proc_pid_rusage every 100 ms (no root needed).

Writes JSON lines until the process exits, the optional time limit passes, or this script is
stopped. Once the footprint has grown by 768 MiB, saves one `footprint` category breakdown and
one `sample` call-stack capture.
Usage: sample-footprint.py <pid> <out.jsonl> <snapshot-dir> [max-seconds]
"""
import ctypes
import json
import os
import subprocess
import sys
import time

FIELDS = [
    "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size",
    "resident_size", "phys_footprint", "proc_start_abstime", "proc_exit_abstime", "child_user_time",
    "child_system_time", "child_pkg_idle_wkups", "child_interrupt_wkups", "child_pageins",
    "child_elapsed_abstime", "diskio_bytesread", "diskio_byteswritten", "cpu_time_qos_default",
    "cpu_time_qos_maintenance", "cpu_time_qos_background", "cpu_time_qos_utility",
    "cpu_time_qos_legacy", "cpu_time_qos_user_initiated", "cpu_time_qos_user_interactive",
    "billed_system_time", "serviced_system_time", "logical_writes", "lifetime_max_phys_footprint",
    "instructions", "cycles", "billed_energy", "serviced_energy", "interval_max_phys_footprint",
    "runnable_time",
]
MIB = 1024 * 1024


class RUsageInfoV4(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in FIELDS]


def main():
    pid = int(sys.argv[1])
    out_path = sys.argv[2]
    snapshot_dir = sys.argv[3]
    deadline = time.time() + float(sys.argv[4]) if len(sys.argv) > 4 else None
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    info = RUsageInfoV4()
    baseline = None
    captured = False
    with open(out_path, "a") as out:
        while deadline is None or time.time() < deadline:
            if libc.proc_pid_rusage(pid, 4, ctypes.byref(info)) != 0:
                out.write(json.dumps({"t": time.time(), "exited": True, "errno": ctypes.get_errno()}) + "\n")
                break
            footprint = info.phys_footprint
            baseline = footprint if baseline is None else baseline
            out.write(json.dumps({"t": time.time(), "fp": footprint, "max": info.lifetime_max_phys_footprint}) + "\n")
            out.flush()
            if not captured and footprint >= baseline + 768 * MIB:
                captured = True
                with open(os.path.join(snapshot_dir, f"footprint-{pid}.txt"), "w") as snapshot:
                    subprocess.Popen(["/usr/bin/footprint", str(pid)], stdout=snapshot, stderr=subprocess.STDOUT)
                with open(os.path.join(snapshot_dir, f"sample-{pid}.err"), "w") as errors:
                    subprocess.Popen(
                        ["/usr/bin/sample", str(pid), "2", "-mayDie", "-file", os.path.join(snapshot_dir, f"sample-{pid}.txt")],
                        stdout=subprocess.DEVNULL,
                        stderr=errors,
                    )
            time.sleep(0.1)


if __name__ == "__main__":
    main()
