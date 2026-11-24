"""Convert Al Kamel analysis CSVs (2026 Zenith races) into compact replay JSON + per-track defaults."""
import csv, json, os, re, statistics as st, collections, sys

SRC = os.environ.get("ZS_CSV_DIR", "csv")
RD = os.environ.get("ZS_RACING_DATA", "racing-data")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "private", "replays")

RACES = [
  ("daytona-12h",        "Daytona International Speedway", "Daytona 12 Hour",          "daytona",        "Daytona 26 12 hour.csv",       "1", 3.56),
  ("miami-12h",          "Homestead-Miami Speedway",       "Homestead-Miami 12 Hour",  "homestead-miami","Miami 26 12 hour.csv",         "",  3.40),
  ("vir-12h",            "Virginia International Raceway", "VIR 12 Hour",              "vir",            "VIR 26 12 hour.csv",           "1", 3.27),
  ("road-america-r1",    "Road America",                   "Road America Endurance 1", "road-america",   "Road America 26 Race 1.csv",   "1", 4.048),
  ("road-america-r2",    "Road America",                   "Road America Endurance 2", "road-america",   "Road America 26 Race 2.csv",   "2", 4.048),
  ("watkins-glen-r1",    "Watkins Glen International",     "Watkins Glen Endurance 1", "watkins-glen",   "Watkins G 26 race 1.csv",      "1", 3.40),
  ("watkins-glen-r2",    "Watkins Glen International",     "Watkins Glen Endurance 2", "watkins-glen",   "Watkins G 26 race 2.csv",      "2", 3.40),
  ("barber-r1",          "Barber Motorsports Park",        "Barber Endurance 1",       "barber",         "Barber 26 Race 1.csv",         "1", 2.38),
  ("barber-r2",          "Barber Motorsports Park",        "Barber Endurance 2",       "barber",         "Barber 26 Race 2.csv",         "2", 2.38),
]

def t2ms(s):
    s = (s or "").strip()
    if not s: return None
    try:
        parts = s.split(":")
        v = 0.0
        for p in parts: v = v * 60 + float(p)
        return int(round(v * 1000))
    except ValueError:
        return None

def read(fn):
    rows = list(csv.reader(open(os.path.join(SRC, fn), encoding="utf-8-sig"), delimiter=";"))
    h = [c.strip() for c in rows[0]]
    return [dict(zip(h, [c.strip() for c in r])) for r in rows[1:] if len(r) > 10]

FLAGS = ["GF", "FCY", "SC", "RF", "FF", "YF", "CHK"]

# fuel defaults from the corrected track sheets (gal per lap between full refuels)
fuel = collections.defaultdict(list); tank = collections.defaultdict(list)
for r in csv.DictReader(open(os.path.join(RD, "data/pit_stops.csv"))):
    pass
by = collections.defaultdict(list)
for r in csv.DictReader(open(os.path.join(RD, "data/pit_stops.csv"))):
    if r["session_label"] and "Race" not in r["stop_label"]: continue
    by[(r["event_id"], r["car"], r["race_number"])].append(r)
for (ev, car, rn), v in by.items():
    v = sorted(v, key=lambda r: int(r["lap"] or 0)); prev = 0
    for r in v:
        lap = int(r["lap"] or 0)
        try: g = float(r["fuel_added_gal"])
        except ValueError: g = None
        if g and g >= 8 and lap - prev >= 8:
            fuel[(ev, car)].append(g / (lap - prev)); tank[(ev, car)].append(g)
        if g: prev = lap

index = []
for rid, track, name, ev, fn, rn, miles in RACES:
    d = read(fn)
    cars = {}
    for r in d:
        n = r["NUMBER"]
        c = cars.setdefault(n, {"n": n, "cls": r["CLASS"], "team": r["TEAM"], "mfr": r["MANUFACTURER"], "drv": {}})
        dn = r["DRIVER_NUMBER"] or "1"
        c["drv"].setdefault(dn, r["DRIVER_NAME"].replace("*", "").strip())
    order = sorted(cars, key=lambda x: int(x) if x.isdigit() else 9999)
    cidx = {n: i for i, n in enumerate(order)}
    carlist = []
    for n in order:
        c = cars[n]; dks = sorted(c["drv"], key=lambda k: int(k) if k.isdigit() else 99)
        c["_dmap"] = {k: i for i, k in enumerate(dks)}
        carlist.append({"n": n, "cls": c["cls"], "team": c["team"], "mfr": c["mfr"], "drivers": [c["drv"][k] for k in dks]})
    laps = []
    start_clock = None
    for r in d:
        el = t2ms(r["ELAPSED"]); lt = t2ms(r["LAP_TIME"]); hr = t2ms(r["HOUR"])
        if el is None or lt is None: continue
        if start_clock is None and hr is not None:
            start_clock = hr - el
        c = cars[r["NUMBER"]]
        laps.append([cidx[r["NUMBER"]], int(r["LAP_NUMBER"]), el, lt,
                     t2ms(r["S1"]) or 0, t2ms(r["S2"]) or 0, t2ms(r["S3"]) or 0,
                     1 if r["CROSSING_FINISH_LINE_IN_PIT"] == "B" else 0,
                     t2ms(r["PIT_TIME"]) or 0,
                     c["_dmap"].get(r["DRIVER_NUMBER"] or "1", 0),
                     int(round(float(r["TOP_SPEED"]) * 10)) if r.get("TOP_SPEED") else 0,
                     FLAGS.index(r["FLAG_AT_FL"]) if r.get("FLAG_AT_FL") in FLAGS else 0])
    laps.sort(key=lambda x: (x[2], x[0]))
    # earliest start clock across all rows (first lap crossing minus elapsed)
    sc = min(t2ms(r["HOUR"]) - t2ms(r["ELAPSED"]) for r in d if t2ms(r["HOUR"]) is not None and t2ms(r["ELAPSED"]) is not None)
    maxel = max(l[2] for l in laps)
    half = 1800000
    dur = (maxel // half) * half if maxel % half < 600000 else ((maxel // half) + 1) * half
    # green reference + pit loss per class
    byc = collections.defaultdict(list)
    for l in laps:
        if not l[7] and not l[8] and l[11] == 0 and l[1] > 1: byc[carlist[l[0]]["cls"]].append(l[3])
    ref = {k: int(st.median(sorted(v)[: max(5, len(v) // 2)])) for k, v in byc.items()}  # median of faster half
    # pit loss = in-lap + out-lap - 2*ref (car class ref)
    percar = collections.defaultdict(dict)
    for l in laps: percar[l[0]][l[1]] = l
    loss = collections.defaultdict(list); lane = collections.defaultdict(list)
    for ci, lp in percar.items():
        cls = carlist[ci]["cls"]
        for n, l in lp.items():
            if l[8] and (n - 1) in lp:
                pt = l[8]
                if 20000 <= pt <= 600000:
                    lane[cls].append(pt)
                    # green-flag stops only: the lap before the in-lap and the lap after the out-lap are at pace
                    b, a = lp.get(n - 2), lp.get(n + 1)
                    if b and a and b[3] < 1.08 * ref[cls] and a[3] < 1.08 * ref[cls]:
                        extra = lp[n - 1][3] + l[3] - 2 * ref[cls] - pt   # transit delta excluding pit-lane time
                        if -60000 < extra < 60000: loss[cls].append(extra)
    pitloss = {k: int(st.median(v)) for k, v in loss.items() if len(v) >= 3}  # transit delta (s) on top of pit-lane time
    def pct(v, q):
        v = sorted(v); return int(v[min(len(v) - 1, max(0, int(round(q * (len(v) - 1)))))])
    pitlane = {k: {"p10": pct(v, .1), "p50": pct(v, .5), "p80": pct(v, .8), "n": len(v)} for k, v in lane.items() if v}
    meta = {"id": rid, "track": track, "event": ev, "name": name, "season": 2026, "series": "Zenith Racing Series",
            "trackMiles": miles, "startClockMs": sc, "durationMs": dur, "flags": FLAGS,
            "teamCars": ["177", "178"], "refLapMs": ref, "transitDeltaMs": pitloss, "pitLaneMs": pitlane,
            "source": "Al Kamel Systems official timing (" + fn + ")"}
    rep = {"meta": meta, "cars": carlist,
           "cols": ["car", "lap", "elapsedMs", "lapMs", "s1", "s2", "s3", "inPit", "pitMs", "drv", "topKph10", "flag"],
           "laps": laps}
    p = os.path.join(OUT, rid + ".json")
    json.dump(rep, open(p, "w"), separators=(",", ":"))
    f177 = fuel.get((ev, "177")) or []; f178 = fuel.get((ev, "178")) or []
    index.append({"id": rid, "name": name, "track": track, "event": ev, "laps": len(laps), "cars": len(carlist),
                  "durationMs": dur, "bytes": os.path.getsize(p),
                  "fuelGalPerLap": {"177": round(st.median(f177), 3) if f177 else None, "178": round(st.median(f178), 3) if f178 else None},
                  "refLapMs": ref, "transitDeltaMs": pitloss, "pitLaneMs": pitlane})
    print(rid, len(laps), "laps", len(carlist), "cars", "dur", dur / 3600000, "h", "ref", ref, "delta", pitloss, "lane", pitlane, "fuel", index[-1]["fuelGalPerLap"])

tanks = [g for v in tank.values() for g in v]
json.dump({"races": index, "tankGalObserved": max(tanks) if tanks else None}, open(os.path.join(OUT, "index.json"), "w"), indent=1)
print("tank max fuel added", max(tanks))
