import pandas as pd
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
src = BASE / "data" / "migr_asytpsm_linear_2_0.csv"
out = BASE / "data" / "flows_ua_agg.csv"

print("Reading", src)

# Read everything, ignore Eurostat comment lines
df = pd.read_csv(src, comment="#", low_memory=False)

print("Original columns:")
for i, c in enumerate(df.columns):
    print(f"{i:2d}: {repr(c)}")

cols = df.columns

def pick(target):
    tgt = target.lower()
    for c in cols:
        if c.strip().lower() == tgt:
            return c
    raise SystemExit(f"Could not find column for {target!r}")

def pick_age_sum(age_map, combos):
    for combo in combos:
        vals = [age_map.get(code) for code in combo]
        vals = [v for v in vals if pd.notna(v)]
        if vals:
            return sum(vals)
    return 0.0

CHILD_COMBOS = [
    ["Y_LT18"],
    ["Y_LT14", "Y15-17"],
    ["Y0-14", "Y15-17"],
    ["Y0-14", "Y14-17"],
]

ELDER_COMBOS = [
    ["Y_GE65"],
    ["Y65-79", "Y_GE80"],
    ["Y65-79", "Y80-84", "Y85-89", "Y_GE90"],
]

cit_col   = pick("citizen")
sex_col   = pick("sex")
age_col   = pick("age")
geo_col   = pick("geo")
time_col  = pick("time_period")
value_col = pick("obs_value")
unit_col  = pick("unit")

print("\nUsing columns:")
print(" citizen :", cit_col)
print(" sex     :", sex_col)
print(" age     :", age_col)
print(" geo     :", geo_col)
print(" time    :", time_col)
print(" value   :", value_col)
print(" unit    :", unit_col)

# Keep only what we need, rename to clean names
df = df[[cit_col, sex_col, age_col, geo_col, time_col, value_col, unit_col]].copy()
df.columns = ["citizen", "sex", "age", "geo", "time_period", "obs_value", "unit"]

# Coerce key dimensions to string
for col in ["citizen", "sex", "age", "geo", "time_period", "unit"]:
    df[col] = df[col].astype(str)

print("\nSample citizen codes:", df["citizen"].dropna().unique().tolist()[:20])

# ---- Filter to Ukrainians, unit = NR (number of persons) ----
df = df[df["citizen"] == "UA"]
if df.empty:
    raise SystemExit("No rows with citizen == 'UA' – check citizen codes above.")

if "NR" in df["unit"].unique():
    df = df[df["unit"] == "NR"]

# Keep numeric values only
df = df[pd.to_numeric(df["obs_value"], errors="coerce").notna()]
df["obs_value"] = df["obs_value"].astype(float)

# ---- Latest time period ----
# ---- Use latest per-geo within last 6 months ----
print("Sample time_period values:", df["time_period"].dropna().unique().tolist()[-10:])

# Convert to datetime (monthly)
df["date"] = pd.to_datetime(df["time_period"], format="%Y-%m", errors="coerce")
df = df[df["date"].notna()]

max_date = df["date"].max()
cutoff = max_date - pd.DateOffset(months=5)  # last 6 months inclusive

print("Global latest date:", max_date)
print("Cutoff date (6-month window):", cutoff)

# Keep only rows within the 6-month window
df = df[(df["date"] >= cutoff) & (df["date"] <= max_date)]

# For each geo, keep its latest available month in that window
latest_by_geo = df.groupby("geo")["date"].transform("max")
df = df[df["date"] == latest_by_geo]

geos = sorted(df["geo"].dropna().unique().tolist())
print("Number of host geos (UA, last 6 months):", len(geos))
print("Host geos (UA, last 6 months):", geos)
print("Unique sex codes (UA, window):", df["sex"].dropna().unique().tolist())
print("Unique age codes (UA, window):", df["age"].dropna().unique().tolist()[:50])


print("Unique sex codes (UA, latest):", df["sex"].dropna().unique().tolist())
print("Unique age codes (UA, latest):", df["age"].dropna().unique().tolist()[:50])

# ---- Age groups (tweak if codes differ) ----
CHILD_AGES = {"Y_LT18", "Y0-14", "Y15-17", "Y14-17", "Y_LT14"}
ELDER_AGES = {"Y_GE65", "Y65-79", "Y_GE80", "Y80-84", "Y85-89", "Y_GE90"}

# --- Disjoint bins ---
core = df[df["age"] != "UNK"]

# Total refugees per host = sex T, age TOTAL (official headline)
total = (
    df[(df["sex"] == "T") & (df["age"] == "TOTAL")]
    [["geo", "obs_value"]]
    .rename(columns={"obs_value": "total_refugees"})
)

# Children (all sexes, <18)
def calc_bucket(df_in, sex_code, combos, label):
    records = []
    for geo, sub in df_in[df_in["sex"] == sex_code].groupby("geo"):
        age_map = dict(zip(sub["age"], sub["obs_value"]))
        val = pick_age_sum(age_map, combos)
        records.append({"geo": geo, label: val})
    return pd.DataFrame(records)

children    = calc_bucket(core, "T", CHILD_COMBOS, "children")
elderly     = calc_bucket(core, "T", ELDER_COMBOS, "elderly")
tot_f       = df[(df["sex"] == "F") & (df["age"] == "TOTAL")][["geo", "obs_value"]].rename(columns={"obs_value": "women_total"})
tot_m       = df[(df["sex"] == "M") & (df["age"] == "TOTAL")][["geo", "obs_value"]].rename(columns={"obs_value": "men_total"})
child_f     = calc_bucket(core, "F", CHILD_COMBOS, "women_child")
child_m     = calc_bucket(core, "M", CHILD_COMBOS, "men_child")
elder_f     = calc_bucket(core, "F", ELDER_COMBOS, "women_elder")
elder_m     = calc_bucket(core, "M", ELDER_COMBOS, "men_elder")

# Unknown ages (sex=T, age=UNK) — tracked separately
unknown_age = (
    df[(df["sex"] == "T") & (df["age"] == "UNK")]
    .groupby("geo", as_index=False)["obs_value"]
    .sum()
    .rename(columns={"obs_value": "unknown_age"})
)

# Merge
flow = (
    total.merge(children, on="geo", how="left")
         .merge(elderly, on="geo", how="left")
         .merge(unknown_age, on="geo", how="left")
         .merge(tot_f, on="geo", how="left")
         .merge(tot_m, on="geo", how="left")
         .merge(child_f, on="geo", how="left")
         .merge(child_m, on="geo", how="left")
         .merge(elder_f, on="geo", how="left")
         .merge(elder_m, on="geo", how="left")
)

for col in ["children", "elderly", "unknown_age",
            "women_total","men_total","women_child","men_child","women_elder","men_elder"]:
    if col in flow.columns:
        flow[col] = flow[col].fillna(0.0)

# Derive adult women/men = total by sex minus child/elder for that sex
flow["women_adult_raw"] = (flow["women_total"] - flow["women_child"] - flow["women_elder"]).clip(lower=0)
flow["men_adult_raw"]   = (flow["men_total"]   - flow["men_child"]   - flow["men_elder"]).clip(lower=0)

# Scale adult men/women so children+elderly+adults ~= total_refugees
flow["adult_total_target"] = (flow["total_refugees"] - flow["children"] - flow["elderly"]).clip(lower=0)
flow["adult_raw_sum"] = flow["women_adult_raw"] + flow["men_adult_raw"]
scale = flow["adult_total_target"] / flow["adult_raw_sum"].replace({0: pd.NA})
flow["women_adult"] = (flow["women_adult_raw"] * scale).fillna(0)
flow["men_adult"]   = (flow["men_adult_raw"]   * scale).fillna(0)

# Percentages (disjoint bins using official total_refugees)
flow.loc[flow["total_refugees"] <= 0, "total_refugees"] = float("nan")
flow["pct_children"]    = flow["children"]    / flow["total_refugees"]
flow["pct_elderly"]     = flow["elderly"]     / flow["total_refugees"]
flow["pct_women_adult"] = flow["women_adult"] / flow["total_refugees"]
flow["pct_men_adult"]   = flow["men_adult"]   / flow["total_refugees"]
flow["pct_unknown_age"] = flow["unknown_age"] / flow["total_refugees"]

# Map Eurostat GEO (ISO2-ish) to ISO3
iso2_to_iso3 = {
    "AT": "AUT", "BE": "BEL", "BG": "BGR", "HR": "HRV", "CY": "CYP",
    "CZ": "CZE", "DE": "DEU", "DK": "DNK", "EE": "EST", "ES": "ESP",
    "FI": "FIN", "FR": "FRA", "GR": "GRC", "EL": "GRC", "HU": "HUN", "IE": "IRL",
    "IS": "ISL", "IT": "ITA", "LT": "LTU", "LU": "LUX", "LV": "LVA",
    "MT": "MLT", "NL": "NLD", "NO": "NOR", "PL": "POL", "PT": "PRT",
    "RO": "ROU", "SE": "SWE", "SI": "SVN", "SK": "SVK",
    "CH": "CHE", "UK": "GBR", "GB": "GBR",
    "AL": "ALB", "BA": "BIH", "RS": "SRB", "ME": "MNE", "MK": "MKD",
    "MD": "MDA", "UA": "UKR"
}

flow["dest_iso3"] = flow["geo"].map(iso2_to_iso3)
flow = flow[flow["dest_iso3"].notna()].copy()

flow = flow[[
    "dest_iso3",
    "total_refugees",
    "pct_children",
    "pct_elderly",
    "pct_women_adult",
    "pct_men_adult",
    "pct_unknown_age"
]]

print("\nPreview:")
print(flow.head())
print("Rows:", len(flow))

print("Writing", out)
flow.to_csv(out, index=False)
