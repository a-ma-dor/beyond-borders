import pandas as pd
from pathlib import Path


BASE = Path(__file__).resolve().parents[1]
SRC = BASE / "data" / "une_rt_a$defaultview_linear_2_0.csv"
OUT = BASE / "data" / "unemployment_clean.csv"

ISO2_TO_ISO3 = {
    "AT": "AUT", "BE": "BEL", "BG": "BGR", "HR": "HRV", "CY": "CYP",
    "CZ": "CZE", "DE": "DEU", "DK": "DNK", "EE": "EST", "ES": "ESP",
    "FI": "FIN", "FR": "FRA", "GR": "GRC", "EL": "GRC", "HU": "HUN", "IE": "IRL",
    "IT": "ITA", "LT": "LTU", "LU": "LUX", "LV": "LVA", "MT": "MLT",
    "NL": "NLD", "PL": "POL", "PT": "PRT", "RO": "ROU", "SE": "SWE",
    "SI": "SVN", "SK": "SVK", "IS": "ISL", "NO": "NOR",
}


def main():
    print("Reading", SRC)
    df = pd.read_csv(SRC, comment="#", low_memory=False)
    df = df[df["STRUCTURE"] == "dataflow"]

    mask = (
        (df["unit"] == "PC_ACT") &
        (df["sex"] == "T") &
        (df["age"] == "Y15-74")
    )
    df = df[mask].copy()
    df = df[pd.to_numeric(df["OBS_VALUE"], errors="coerce").notna()]
    df["OBS_VALUE"] = df["OBS_VALUE"].astype(float)
    df["TIME_PERIOD"] = pd.to_numeric(df["TIME_PERIOD"], errors="coerce")

    latest = df.loc[df.groupby("geo")["TIME_PERIOD"].idxmax()].copy()
    latest["dest_iso3"] = latest["geo"].map(ISO2_TO_ISO3)
    latest = latest[latest["dest_iso3"].notna()]
    latest["unemployment"] = latest["OBS_VALUE"] / 100.0

    out_df = latest[["dest_iso3", "unemployment", "TIME_PERIOD"]].rename(columns={"TIME_PERIOD": "year"})
    print("Rows:", len(out_df))
    print("Writing", OUT)
    out_df.to_csv(OUT, index=False)


if __name__ == "__main__":
    main()
