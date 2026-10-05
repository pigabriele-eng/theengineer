"""Car and tyre defaults for the tyre tools (BMW M4 GT4 Evo on Pirelli P Zero DHG slicks), kept in one place.

From the car research (reference/bmw-m4-gt4-evo/car.json, compiled 2026-10-05): ADAC GT4 Germany has run the
Pirelli P Zero DHG since April 2025. Its 2025 P_Book (minimum and hot target pressures) is issued to teams and is
not public, so the minimums table ships empty and the app asks for the values (stored per series in the
database, PUT /tyres/minimums). Older public Pirelli GT4 booklets give the figures in OLDER_BOOKLET; they are shown
only as a reference to check against the team's P_Book, never as DHG values or as the minimums checked against.
Pirelli publishes no GT4 temperature window. The pyrometer target spread is a rule of thumb, labelled as such.
"""

ATMOSPHERIC_BAR = 1.013  # standard sea-level atmosphere; every calculation takes the day's value instead

# P-Book minimums shipped with the app: {"series", "tyre", "axle": "front"|"rear", "cold_min_bar",
# "hot_min_bar", "source"}. Empty: the DHG P_Book is not public.
PBOOK_MINIMUMS: list[dict] = []
PBOOK_NOTE = ("The 2025 Pirelli P_Book for the P Zero DHG is issued to teams and is not public: enter the minimums "
              "from your copy.")

# The tyre maker's hot pressure windows: {"tyre", "axle", "low_bar", "high_bar", "source"}. None published.
HOT_WINDOWS: list[dict] = []

_BOOKLET_2019 = ("https://www.gt-world-challenge-asia.com/documents/team/582/"
                 "P_Book%20-%20Blancpain%20GT%20World%20Challenge%20Asia%20GT4%202019.pdf")
_BOOKLET_2018 = ("https://www.gt-world-challenge-asia.com/documents/team/206/"
                 "P_Book%20-%20Blancpain%20GT%20Series%20Asia%202018%20GT4.pdf")
OLDER_BOOKLET = {
    "label": "older Pirelli GT4 booklet (2018/2019, DH tyre), not the DHG P_Book: check against your P_Book",
    "min_pressure_bar": 1.4,  # "minimum inflation pressure"
    "hot_target_bar": 2.0,
    "max_camber_deg": {"front": -3.5, "rear": -3.0},  # maximum static camber
    "max_inside_outside_c": 20.0,  # garage bulk temperature, inside against outside
    "max_front_rear_c": 25.0,  # garage bulk temperature, front axle against rear
    "source": _BOOKLET_2019,
    "front_rear_source": _BOOKLET_2018,
}

# Pyrometer target: an estimate, not a Pirelli figure
TARGET_SPREAD_C = 8.0  # inside edge hotter than the outside by this much
TARGET_SPREAD_SOURCE = ("Estimate: a commonly used starting target (inside edge 5-10 °C hotter than the outside), "
                        "not a Pirelli figure; older Pirelli GT4 booklets only give a 20 °C maximum. Change it to "
                        "your tyre engineer's number.")
