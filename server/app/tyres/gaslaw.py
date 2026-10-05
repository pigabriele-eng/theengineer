"""Ideal gas law for a tyre: the same air at a different temperature, at (nearly) constant volume.

Gauges and TPMS read gauge pressure (above the atmosphere); the gas law works in absolute pressure and kelvin.
"""
from app.tyres.presets import ATMOSPHERIC_BAR

KELVIN = 273.15


def hot_from_cold(cold_bar: float, cold_c: float, hot_c: float, atmospheric_bar: float = ATMOSPHERIC_BAR) -> float:
    """Gauge pressure (bar) when air set at cold_bar and cold_c warms to hot_c."""
    return (cold_bar + atmospheric_bar) * (hot_c + KELVIN) / (cold_c + KELVIN) - atmospheric_bar


def cold_from_hot(hot_bar: float, hot_c: float, cold_c: float, atmospheric_bar: float = ATMOSPHERIC_BAR) -> float:
    """Gauge pressure (bar) to set at cold_c so the tyre reaches hot_bar at hot_c."""
    return (hot_bar + atmospheric_bar) * (cold_c + KELVIN) / (hot_c + KELVIN) - atmospheric_bar
