"""Steady-state vehicle model: wheel and ride rates, roll stiffness, load transfer and balance.

The equations are the standard ones from Milliken & Milliken, Race Car Vehicle Dynamics (SAE, 1995): ride and
roll rates from springs, bars, motion ratios and tyres (ch. 16, Ride and Roll Rates) and the steady-state
lateral load transfer of each axle split into its geometric (roll centre), elastic (springs and bars) and
unsprung parts (ch. 18, Wheel Loads). Assumptions: linear springs and tyres, a rigid chassis, small roll
angles, the roll axis as a straight line between the two roll centres, the unsprung mass's centre at wheel
centre height. Tyres act as springs in series with the suspension in both heave and roll.

Units: every input and output carries its unit in its name (mm, kg, N/mm, N, Nm/deg, km/h, g). Everything is
converted to SI (m, N/m, Nm/rad) inside the functions.

Motion ratio convention: spring (or bar link) travel divided by wheel travel, so 0.7 means the spring moves
7 mm when the wheel moves 10 mm, and a spring's rate at the wheel is its rate times the ratio squared.
Anti-roll bar rate convention: the force at one drop link per mm of that link's travel with the other end held.
"""
from __future__ import annotations

import math

from pydantic import BaseModel, Field, model_validator

G = 9.81


class Vehicle(BaseModel):
    """A car and its setup, as the model needs them. All rates are the part's own rate (at the spring or link)."""

    mass_kg: float = Field(gt=0, description="Total mass with driver and fuel")
    front_weight_fraction: float = Field(gt=0, lt=1, description="Static front axle load / total")
    cog_height_mm: float = Field(gt=0)
    wheelbase_mm: float = Field(gt=0)
    track_front_mm: float = Field(gt=0)
    track_rear_mm: float = Field(gt=0)
    roll_centre_front_mm: float = Field(0.0, description="Height above ground; negative is below")
    roll_centre_rear_mm: float = 0.0
    spring_front_n_per_mm: float = Field(gt=0)
    spring_rear_n_per_mm: float = Field(gt=0)
    spring_mr_front: float = Field(1.0, gt=0, description="Spring travel / wheel travel")
    spring_mr_rear: float = Field(1.0, gt=0)
    arb_front_n_per_mm: float = Field(0.0, ge=0, description="Bar rate at one drop link, other end held; 0 = none")
    arb_rear_n_per_mm: float = Field(0.0, ge=0)
    arb_mr_front: float = Field(1.0, gt=0, description="Drop link travel / wheel travel")
    arb_mr_rear: float = Field(1.0, gt=0)
    # A bar with numbered settings: its rate at each setting, softest first, and the setting in use (1 = softest).
    # When both are given they replace arb_*_n_per_mm.
    arb_front_settings_n_per_mm: list[float] | None = None
    arb_rear_settings_n_per_mm: list[float] | None = None
    arb_front_setting: int | None = None
    arb_rear_setting: int | None = None
    tyre_vertical_front_n_per_mm: float = Field(300.0, gt=0)
    tyre_vertical_rear_n_per_mm: float = Field(300.0, gt=0)
    tyre_radius_mm: float = Field(330.0, gt=0, description="Loaded radius: the height of the unsprung mass")
    unsprung_front_kg: float = Field(0.0, ge=0, description="Per corner")
    unsprung_rear_kg: float = Field(0.0, ge=0)
    downforce_n: float = Field(0.0, ge=0, description="Total downforce at the reference speed; 0 = ignore aero")
    aero_balance_front: float = Field(0.5, ge=0, le=1, description="Front share of the downforce")
    aero_ref_speed_kmh: float = Field(200.0, gt=0)
    braking_g: float = Field(1.4, ge=0, description="Deceleration for the longitudinal transfer output")
    acceleration_g: float = Field(0.5, ge=0)

    @model_validator(mode="after")
    def _check(self) -> Vehicle:
        for axle in ("front", "rear"):
            rates, pos = getattr(self, f"arb_{axle}_settings_n_per_mm"), getattr(self, f"arb_{axle}_setting")
            if rates and pos is not None and not 1 <= pos <= len(rates):
                raise ValueError(f"{axle} bar setting {pos} is outside 1-{len(rates)}")
        m_u = 2 * (self.unsprung_front_kg + self.unsprung_rear_kg)
        if self.unsprung_front_kg * 2 >= self.mass_kg * self.front_weight_fraction or m_u >= self.mass_kg:
            raise ValueError("Unsprung mass is larger than the axle load")
        return self

    def arb_rate(self, axle: str) -> float:
        """The bar's rate in N/mm at the setting in use."""
        rates, pos = getattr(self, f"arb_{axle}_settings_n_per_mm"), getattr(self, f"arb_{axle}_setting")
        if rates and pos is not None:
            return float(rates[pos - 1])
        return float(getattr(self, f"arb_{axle}_n_per_mm"))


def _series(k1: float, k2: float) -> float:
    return k1 * k2 / (k1 + k2) if k1 > 0 and k2 > 0 else 0.0


def compute(v: Vehicle) -> dict:
    """Rates, frequencies, roll stiffness, load transfer and balance for one setup.

    Per axle (RCVD ch. 16):
      wheel rate        K_w   = k_spring * MR_spring^2
      bar at the wheel  K_b   = 2 * k_bar * MR_bar^2   (both links move, opposite ways, in roll)
      ride rate         K_r   = K_w * K_t / (K_w + K_t)          (tyre K_t in series; the bar does not act in heave)
      ride frequency    f     = sqrt(K_r / m_corner) / (2 pi)    (m_corner = sprung mass on one corner)
      roll stiffness    K_phi = (K_w + K_b) t^2 / 2  in series with the tyres' K_t t^2 / 2   [Nm/rad]

    Whole car (RCVD ch. 18), per g of lateral acceleration A_y:
      roll axis height under the sprung CoG  z_ra = z_rf + (z_rr - z_rf) a_s / L
      roll arm                               H    = h_s - z_ra
      roll gradient                          phi / A_y = W_s H / (K_phi_f + K_phi_r - W_s H)
      lateral load transfer of the front     dFz_f = [K_phi_f phi + W_s (b_s / L) z_rf + W_uf r_t] / t_f
                                                      (elastic)    (geometric)          (unsprung)
      and the same for the rear with K_phi_r, a_s / L, z_rr, W_ur, t_r.
    W_s is the sprung weight, a_s and b_s the sprung CoG's distances to the front and rear axles, h_s its height,
    r_t the tyre radius. Longitudinal transfer is W h / L per g (all of it, whatever the anti-dive or anti-squat).
    """
    m, wf = v.mass_kg, v.front_weight_fraction
    L, h = v.wheelbase_mm / 1000, v.cog_height_mm / 1000
    r_t = v.tyre_radius_mm / 1000
    m_uf, m_ur = 2 * v.unsprung_front_kg, 2 * v.unsprung_rear_kg
    m_sf, m_sr = m * wf - m_uf, m * (1 - wf) - m_ur
    m_s = m_sf + m_sr
    a_s = L * m_sr / m_s  # sprung CoG behind the front axle
    h_s = (m * h - (m_uf + m_ur) * r_t) / m_s

    axles: dict[str, dict] = {}
    k_phi: dict[str, float] = {}
    for axle, track_mm, k_s, mr_s, mr_b, k_t, m_sprung in (
        ("front", v.track_front_mm, v.spring_front_n_per_mm, v.spring_mr_front, v.arb_mr_front,
         v.tyre_vertical_front_n_per_mm, m_sf),
        ("rear", v.track_rear_mm, v.spring_rear_n_per_mm, v.spring_mr_rear, v.arb_mr_rear,
         v.tyre_vertical_rear_n_per_mm, m_sr),
    ):
        t = track_mm / 1000
        k_w = k_s * 1000 * mr_s**2  # N/m at the wheel
        k_b = 2 * v.arb_rate(axle) * 1000 * mr_b**2
        k_tyre = k_t * 1000
        k_ride = _series(k_w, k_tyre)
        phi_springs, phi_bar, phi_tyres = k_w * t**2 / 2, k_b * t**2 / 2, k_tyre * t**2 / 2
        k_phi[axle] = _series(phi_springs + phi_bar, phi_tyres)
        axles[axle] = {
            "sprung_mass_kg": round(m_sprung, 1),
            "wheel_rate_n_per_mm": round(k_w / 1000, 1),
            "bar_wheel_rate_n_per_mm": round(k_b / 1000, 1),
            "ride_rate_n_per_mm": round(k_ride / 1000, 1),
            "ride_frequency_hz": round(math.sqrt(k_ride / (m_sprung / 2)) / (2 * math.pi), 3),
            "roll_stiffness_springs_nm_per_deg": round(phi_springs * math.pi / 180, 1),
            "roll_stiffness_bar_nm_per_deg": round(phi_bar * math.pi / 180, 1),
            "roll_stiffness_nm_per_deg": round(k_phi[axle] * math.pi / 180, 1),
        }

    w_s = m_s * G
    z_rf, z_rr = v.roll_centre_front_mm / 1000, v.roll_centre_rear_mm / 1000
    z_ra = z_rf + (z_rr - z_rf) * a_s / L
    arm = h_s - z_ra
    k_total = k_phi["front"] + k_phi["rear"]
    if k_total <= w_s * arm:
        raise ValueError("Roll stiffness is too low to hold the body up: check springs, bars and motion ratios")
    phi_per_g = w_s * arm / (k_total - w_s * arm)  # rad per g
    for axle, t_mm, share, z_rc, m_u in (("front", v.track_front_mm, (L - a_s) / L, z_rf, m_uf),
                                          ("rear", v.track_rear_mm, a_s / L, z_rr, m_ur)):
        t = t_mm / 1000
        parts = {
            "geometric": w_s * share * z_rc / t,
            "elastic": k_phi[axle] * phi_per_g / t,
            "unsprung": m_u * G * r_t / t,
        }
        parts["total"] = sum(parts.values())
        axles[axle]["lateral_load_transfer_n_per_g"] = {k: round(x, 1) for k, x in parts.items()}

    llt_f = axles["front"]["lateral_load_transfer_n_per_g"]["total"]
    llt_r = axles["rear"]["lateral_load_transfer_n_per_g"]["total"]
    llt_share = llt_f / (llt_f + llt_r)
    long_per_g = m * G * h / L
    df_front_share = None
    if v.downforce_n > 0:
        df_front_share = (m * G * wf + v.downforce_n * v.aero_balance_front) / (m * G + v.downforce_n)

    return {
        "axles": axles,
        "ride_frequency_ratio": round(axles["rear"]["ride_frequency_hz"] / axles["front"]["ride_frequency_hz"], 3),
        "roll_stiffness_front_share": round(k_phi["front"] / k_total, 4),
        "roll_gradient_deg_per_g": round(math.degrees(phi_per_g), 3),
        "sprung_cog_height_mm": round(h_s * 1000, 1),
        "roll_axis_height_mm": round(z_ra * 1000, 1),
        "roll_arm_mm": round(arm * 1000, 1),
        "lateral_load_transfer_front_share": round(llt_share, 4),
        "longitudinal": {
            "per_g_n": round(long_per_g, 1),
            "braking_g": v.braking_g,
            "braking_front_gain_n": round(long_per_g * v.braking_g, 1),
            "acceleration_g": v.acceleration_g,
            "acceleration_rear_gain_n": round(long_per_g * v.acceleration_g, 1),
        },
        "balance": balance(llt_share, wf, df_front_share, v.aero_ref_speed_kmh),
    }


def _reading(diff: float, where: str) -> str:
    points = abs(diff) * 100
    if diff > 0.05:
        return (f"{where}the front takes {points:.1f} points more of the cornering load transfer than its share "
                "of the load: a clear understeer tendency.")
    if diff > 0.015:
        return (f"{where}the front takes {points:.1f} points more of the load transfer than its share of the "
                "load: a mild understeer tendency.")
    if diff >= -0.015:
        return f"{where}load transfer is shared about in proportion to the load: close to neutral."
    if diff >= -0.05:
        return (f"{where}the rear takes {points:.1f} points more of the load transfer than its share of the "
                "load: a mild oversteer tendency.")
    return (f"{where}the rear takes {points:.1f} points more of the load transfer than its share of the load: "
            "a clear oversteer tendency.")


def balance(llt_front_share: float, front_weight: float, front_load_at_speed: float | None = None,
            speed_kmh: float = 200.0) -> dict:
    """A simple balance indicator: the front's share of lateral load transfer against its share of the load.

    Tyres lose grip per unit load as load rises, so the axle carrying more of the load transfer than of the load
    saturates first. More front share means more understeer tendency. This is a tendency at the limit, all else
    (tyres, geometry, aero, diff) equal, not a prediction of the car's balance.
    """
    diff = llt_front_share - front_weight
    out = {
        "front_weight_share": round(front_weight, 4),
        "lateral_load_transfer_front_share": round(llt_front_share, 4),
        "difference": round(diff, 4),
        "reading": _reading(diff, "At low speed "),
        "front_load_share_at_speed": None,
        "difference_at_speed": None,
        "reading_at_speed": None,
    }
    if front_load_at_speed is not None:
        d = llt_front_share - front_load_at_speed
        out |= {"front_load_share_at_speed": round(front_load_at_speed, 4), "difference_at_speed": round(d, 4),
                "reading_at_speed": _reading(d, f"At {speed_kmh:.0f} km/h with downforce ")}
    return out


# The outputs a what-if compares: (key, label, unit, how to read it from compute()'s result)
METRICS: tuple[tuple[str, str, str, tuple], ...] = (
    ("ride_frequency_front_hz", "Ride frequency front", "Hz", ("axles", "front", "ride_frequency_hz")),
    ("ride_frequency_rear_hz", "Ride frequency rear", "Hz", ("axles", "rear", "ride_frequency_hz")),
    ("ride_frequency_ratio", "Ride frequency rear / front", "", ("ride_frequency_ratio",)),
    ("roll_stiffness_front_nm_per_deg", "Roll stiffness front", "Nm/deg",
     ("axles", "front", "roll_stiffness_nm_per_deg")),
    ("roll_stiffness_rear_nm_per_deg", "Roll stiffness rear", "Nm/deg", ("axles", "rear", "roll_stiffness_nm_per_deg")),
    ("roll_stiffness_front_share", "Roll stiffness front share", "%", ("roll_stiffness_front_share",)),
    ("roll_gradient_deg_per_g", "Roll gradient", "deg/g", ("roll_gradient_deg_per_g",)),
    ("llt_front_n_per_g", "Lateral load transfer front", "N/g",
     ("axles", "front", "lateral_load_transfer_n_per_g", "total")),
    ("llt_rear_n_per_g", "Lateral load transfer rear", "N/g",
     ("axles", "rear", "lateral_load_transfer_n_per_g", "total")),
    ("llt_front_share", "Load transfer front share", "%", ("lateral_load_transfer_front_share",)),
    ("balance_difference", "Front load transfer share minus front load share", "%", ("balance", "difference")),
    ("longitudinal_per_g_n", "Longitudinal load transfer", "N/g", ("longitudinal", "per_g_n")),
)


class Change(BaseModel):
    """One change to a setup: set a field to a value, add to it, or scale it by a percentage."""

    field: str
    set: float | None = None
    add: float | None = None
    percent: float | None = None


def apply_changes(base: Vehicle, changes: list[Change]) -> Vehicle:
    data = base.model_dump()
    for c in changes:
        current = data.get(c.field)
        if c.field not in Vehicle.model_fields or isinstance(current, list):
            raise ValueError(f"'{c.field}' is not a setup value that can be changed")
        if sum(x is not None for x in (c.set, c.add, c.percent)) != 1:
            raise ValueError(f"Give exactly one of set, add or percent for '{c.field}'")
        if current is None and c.set is None:
            raise ValueError(f"'{c.field}' has no value in the baseline to change")
        new = c.set if c.set is not None else current + c.add if c.add is not None else current * (1 + c.percent / 100)
        data[c.field] = round(new) if c.field.endswith("_setting") else new
    return Vehicle.model_validate(data)


def _pick(result: dict, path: tuple) -> float:
    for k in path:
        result = result[k]
    return float(result)


def what_if(base: Vehicle, changes: list[Change]) -> dict:
    """The baseline, the changed setup, the change in each key output and one sentence on the balance."""
    changed = apply_changes(base, changes)
    a, b = compute(base), compute(changed)
    deltas = []
    for key, label, unit, path in METRICS:
        x, y = _pick(a, path), _pick(b, path)
        scale = 100 if unit == "%" else 1
        deltas.append({"key": key, "label": label, "unit": unit, "baseline": round(x * scale, 3),
                       "changed": round(y * scale, 3), "delta": round((y - x) * scale, 3)})
    return {"baseline": a, "changed": b, "deltas": deltas, "summary": summary(a, b)}


def summary(a: dict, b: dict) -> str:
    """One sentence on what a change does to the balance, from the shift in the front share of load transfer."""
    x, y = a["lateral_load_transfer_front_share"] * 100, b["lateral_load_transfer_front_share"] * 100
    rg = f"; roll gradient {a['roll_gradient_deg_per_g']:.2f} to {b['roll_gradient_deg_per_g']:.2f} deg/g"
    shift = f"front share of lateral load transfer {x:.1f} % to {y:.1f} %"
    if abs(y - x) < 0.1:
        return f"Hardly changes the balance ({shift}{rg})."
    if y > x:
        return f"Moves load transfer to the front ({shift}{rg}): more understeer, or less oversteer, at the limit."
    return f"Moves load transfer to the rear ({shift}{rg}): less understeer, or more oversteer, at the limit."
