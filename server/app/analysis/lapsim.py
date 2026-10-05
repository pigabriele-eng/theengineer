"""Theoretical lap: the driven line taken at the car's own demonstrated limits everywhere.

A quasi-steady-state lap simulation. The line's curvature caps the speed in every corner, then the car
accelerates out of each one and brakes into the next as hard as its learned limits allow, trading grip
between cornering and braking or acceleration along its g-g envelope.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.analysis.channels import G
from app.analysis.limits import CarLimits

V_STEP = 2.0  # km/h, lookup resolution
AY_STEP = 0.02  # g
AY_MAX = 4.0
CURVE_SMOOTH_M = 9
LIMITED_BY = ("corner", "accel", "brake")


@dataclass
class SimLap:
    speed: np.ndarray  # km/h per grid point
    t: np.ndarray  # s, elapsed at each grid point
    time: float
    limited_by: np.ndarray  # index into LIMITED_BY per grid point


def _tables(lim: CarLimits, v_top: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Available acceleration and braking (g) for each speed and lateral g, and the cornering limit per speed."""
    vg = np.arange(0, v_top + 2 * V_STEP, V_STEP)
    ayg = np.arange(0, AY_MAX + AY_STEP, AY_STEP)
    theta = np.radians(np.arange(0, 91, 2.0))
    acc = np.zeros((len(vg), len(ayg)))
    brk = np.zeros((len(vg), len(ayg)))
    for i, v in enumerate(vg):
        for sign, table in ((1, acc), (-1, brk)):
            e = lim.grip(np.full(len(theta), v), sign * np.degrees(theta))
            lat, lon = e * np.cos(theta), e * np.sin(theta)
            lat = np.minimum.accumulate(lat)  # keep it a single-valued boundary
            table[i] = np.interp(ayg, lat[::-1], lon[::-1], right=0.0)
        a_line = float(np.interp(v, lim.line_speeds, lim.accel, right=0.0))
        b_line = float(np.interp(v, lim.line_speeds, lim.brake))
        acc[i] = np.minimum(acc[i], a_line)
        if brk[i, 0] > 0:  # the straight-line braking curve, shaped by the envelope as cornering g rises
            brk[i] *= b_line / brk[i, 0]
    return vg, acc, brk


def theoretical_lap(curvature: np.ndarray, lim: CarLimits, step: float = 1.0) -> SimLap:
    """Fastest lap on a closed line with the given curvature (1/m per grid point)."""
    k = np.abs(curvature)
    w = max(1, round(CURVE_SMOOTH_M / step)) | 1
    k = np.convolve(np.pad(k, w // 2, mode="wrap"), np.ones(w) / w, "valid")
    k = np.maximum(k, 1e-5)
    v_top = lim.top_speed * 1.02
    vg, acc, brk = _tables(lim, v_top)

    # speed each corner allows on its own, solved by iteration because downforce makes grip speed dependent
    vc = np.full(len(k), v_top / 3.6)
    for _ in range(8):
        vc = np.minimum(np.sqrt(lim.max_lateral(vc * 3.6) * G / k), v_top / 3.6)

    n = len(k)
    kk = np.concatenate([k, k]).tolist()
    vcc = np.concatenate([vc, vc]).tolist()
    nv, na = len(vg) - 1, acc.shape[1] - 1
    acc_l, brk_l = acc.tolist(), brk.tolist()
    ds = step

    def look(table, v, ay):
        return table[min(int(v * 3.6 / V_STEP + 0.5), nv)][min(int(ay / AY_STEP + 0.5), na)]

    # two laps forward, so the line is crossed at the speed the lap really carries
    fwd = [0.0] * (2 * n)
    fwd[0] = vcc[0]
    for i in range(2 * n - 1):
        v = fwd[i]
        a = look(acc_l, v, v * v * kk[i] / G)
        fwd[i + 1] = min((v * v + 2 * a * G * ds) ** 0.5, vcc[i + 1])
    bwd = fwd[:]
    for i in range(2 * n - 2, -1, -1):
        v = bwd[i + 1]
        b = look(brk_l, v, v * v * kk[i + 1] / G)
        bwd[i] = min(bwd[i], (v * v + 2 * b * G * ds) ** 0.5)
    v = np.array(bwd[n:])
    f = np.array(fwd[n:])
    limited = np.where(v < f - 1e-6, 2, np.where(np.isclose(v, vc, rtol=1e-3), 0, 1))
    seg = 2 * ds / (v + np.roll(v, -1))
    t = np.concatenate([[0.0], np.cumsum(seg[:-1])])
    return SimLap(v * 3.6, t, float(t[-1] + seg[-1]), limited)
