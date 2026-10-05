"""Car presets for the vehicle model and the tyre fit, with where each number comes from.

Published values cite their source; every other value is an editable estimate with its reasoning, so a measured
number can replace it. The BMW M4 GT4 EVO values come from the car research file
(reference/bmw-m4-gt4-evo/car.json, compiled 2026-10-05); the key in brackets is where each one sits in it.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

from app.vehicle.model import Vehicle

BMW_PRESS_EVO = ("https://www.press.bmwgroup.com/global/article/detail/T0443468EN/tailored-updates:-bmw-m4-gt4-evo-"
                 "responds-to-feedback-from-bmw-m-motorsport-customers?language=en")

BAR_MR = "Unknown; the bar estimates above are already at the wheel."


@dataclass(frozen=True)
class Value:
    value: float | int | list[float] | None
    confidence: str  # published, estimate or unknown
    source: str | None
    note: str


def _est(value, note: str, key: str | None = None) -> Value:
    return Value(value, "estimate", f"car research file [{key}]" if key else None, note)


BMW_M4_GT4_EVO: dict[str, Value] = {
    "mass_kg": _est(1635, "1480 kg SRO base minimum (published, without driver and fuel) + about 30 kg BoP ballast "
                    "+ 85 kg driver + about 40 kg fuel. Range 1600-1680 kg with BoP, success ballast and fuel.",
                    "mass.race_weight_with_driver_and_fuel"),
    "front_weight_fraction": _est(0.52, "Not published. Front-engined straight six with the gearbox behind it; the "
                                  "fuel cell and BoP ballast move mass rearward. Range 0.50-0.54: measure on scales.",
                                  "mass.weight_distribution_front"),
    "cog_height_mm": _est(460, "Not published. Road coupes of this size sit at 480-520 mm; the GT4 is stripped but "
                          "runs high BoP ride heights. Range 430-490 mm with driver.", "mass.cog_height"),
    "wheelbase_mm": Value(2857, "published", BMW_PRESS_EVO, "BMW press release for the EVO [dimensions.wheelbase]."),
    "track_front_mm": _est(1650, "No GT4 figure is public. Road car 1617 mm; the GT4 runs 11J rims under wider "
                           "arches. Range 1630-1680 mm: measure it.", "dimensions.track_front"),
    "track_rear_mm": _est(1640, "No GT4 figure is public. Road car 1605 mm, GT4 on 11J rims. Range 1620-1670 mm.",
                          "dimensions.track_rear"),
    "roll_centre_front_mm": _est(55, "Not public. Middle of the 30-80 mm range for a lowered strut front axle; low "
                                 "confidence, it only sets the geometric part of the load transfer.",
                                 "suspension.roll_centre_heights"),
    "roll_centre_rear_mm": _est(105, "Not public. Middle of the 80-130 mm range for a multi-link rear; low "
                                "confidence.", "suspension.roll_centre_heights"),
    "spring_front_n_per_mm": _est(148, "The H&R rates are not public. Back-calculated for a 2.5 Hz front ride "
                                  "frequency at MR 0.95 with the tyre in series: replace with the rate on the spring.",
                                  "estimates_for_tools.spring_rate_back_calc_example"),
    "spring_rear_n_per_mm": _est(268, "Back-calculated for 2.6 Hz at MR 0.70; 182 N/mm if the rear MR is 0.85. "
                                 "Replace with the rate on the spring.",
                                 "estimates_for_tools.spring_rate_back_calc_example"),
    "spring_mr_front": _est(0.95, "Not public. A strut coilover acts almost at the wheel: 0.92-0.98. Measure it: "
                            "lift the wheel 10 mm and record the spring compression.", "suspension.motion_ratio_front"),
    "spring_mr_rear": _est(0.70, "Not public. Spring on a lower link inboard of the hub: 0.6-0.7; a coilover at the "
                           "damper: 0.75-0.85.", "suspension.motion_ratio_rear"),
    "arb_front_settings_n_per_mm": _est(
        [20.0, 30.0, 40.0, 50.0, 60.0],
        "The bars are 5-position adjustable front and rear (published, BMW press kit), but their rates and motion "
        "ratios are not. These are wheel-equivalent rates (motion ratio 1.0) chosen so that, at the middle "
        "settings, the front takes about 55 % of the roll stiffness and the roll gradient is about 1.05 deg/g, usual "
        "for a front-engined GT4. Replace with measured rates.", "suspension.anti_roll_bars"),
    "arb_rear_settings_n_per_mm": _est(
        [5.0, 10.0, 15.0, 20.0, 25.0],
        "As for the front bar: wheel-equivalent estimates, softer than the front.", "suspension.anti_roll_bars"),
    "arb_front_setting": _est(3, "The setting in use is not known here: the middle one. Set yours.", None),
    "arb_rear_setting": _est(3, "The setting in use is not known here: the middle one. Set yours.", None),
    "arb_mr_front": _est(1.0, BAR_MR, "suspension.motion_ratio_arb"),
    "arb_mr_rear": _est(1.0, BAR_MR, "suspension.motion_ratio_arb"),
    "tyre_vertical_front_n_per_mm": _est(300, "Proxy from Pirelli booklets for similar 18-inch slicks: about 280-400 "
                                         "N/mm over 1.6-2.2 bar.", "tyres.vertical_stiffness"),
    "tyre_vertical_rear_n_per_mm": _est(300, "Same tyre front and rear (280/660-18 DHG on 11J, an inference).",
                                        "tyres.vertical_stiffness"),
    "tyre_radius_mm": _est(322, "Loaded radius: 333 mm unloaded (2093 mm circumference) less about 10 mm at race "
                           "load.", "tyres.unloaded_radius"),
    "unsprung_front_kg": _est(50, "Slick, 11x18 rim, disc, caliper, upright and part of the links. Range 42-58 kg.",
                              "mass.unsprung_mass_per_corner"),
    "unsprung_rear_kg": _est(50, "As for the front. Range 42-58 kg.", "mass.unsprung_mass_per_corner"),
    "downforce_n": _est(1200, "No aero data is published. A GT4 has modest aero: about 0.6 m2 of lift area gives "
                        "1100-1200 N at 200 km/h. Range 800-2000 N; it matters for the tyre fit at high speed.",
                        "aero.downforce_drag_cop"),
    "aero_balance_front": _est(0.40, "Not published. A rear wing and a modest splitter usually give a rear-biased "
                               "balance; range 0.35-0.50.", "aero.downforce_drag_cop"),
    "aero_ref_speed_kmh": _est(200, "The speed the downforce above is quoted at.", None),
    "braking_g": _est(1.5, "Typical peak braking on GT4 slicks; the Hockenheim logs peak at about 1.5 g.", None),
    "acceleration_g": _est(0.55, "Typical traction-limited acceleration in second gear; about 0.55 g in the logs.",
                           None),
}

STEERING_RATIO = Value(None, "unknown", None,
                       "Not published. The car's logger records a road-wheel angle (aSteer) next to the steering "
                       "wheel angle (aSteerWheel), at about 15.7:1 near centre and 14:1 at large angles, so the tyre "
                       "fit uses aSteer directly. Enter a ratio to override it.")

PRESETS: dict[str, tuple[str, dict[str, Value], Value]] = {
    "bmw-m4-gt4-evo": ("BMW M4 GT4 EVO (G82)", BMW_M4_GT4_EVO, STEERING_RATIO),
}


def preset_vehicle(key: str) -> Vehicle:
    if key not in PRESETS:
        raise KeyError(key)
    return Vehicle(**{k: v.value for k, v in PRESETS[key][1].items()})


def preset_detail(key: str) -> dict:
    name, values, steering = PRESETS[key]
    return {
        "key": key,
        "name": name,
        "vehicle": preset_vehicle(key).model_dump(),
        "values": {k: asdict(v) for k, v in values.items()},
        "steering_ratio": asdict(steering),
        "published": sorted(k for k, v in values.items() if v.confidence == "published"),
    }
