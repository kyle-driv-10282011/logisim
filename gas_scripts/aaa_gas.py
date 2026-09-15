#!/usr/bin/env python3

import csv
import os
import platform
import re
import subprocess
import tempfile


def _is_wsl():
    if platform.system() != "Linux":
        return False

    try:
        with open("/proc/version") as f:
            return "microsoft" in f.read().lower()
    except OSError:
        return False


def _windows_ca_bundle():
    """Export every cert in the Windows certificate store to a PEM bundle.

    Used under WSL, where Python only sees the Linux trust store and
    can't reach the Windows CryptoAPI store that truststore relies on.
    """
    ps_script = (
        "$stores = 'Cert:\\LocalMachine\\Root','Cert:\\LocalMachine\\CA',"
        "'Cert:\\CurrentUser\\Root','Cert:\\CurrentUser\\CA'; "
        "Get-ChildItem $stores -ErrorAction SilentlyContinue | "
        "ForEach-Object { "
        "'-----BEGIN CERTIFICATE-----'; "
        "[Convert]::ToBase64String($_.RawData, 'InsertLineBreaks'); "
        "'-----END CERTIFICATE-----' }"
    )

    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", ps_script],
        capture_output=True,
        text=True,
        check=True,
    )

    bundle = tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".pem",
        delete=False
    )
    bundle.write(result.stdout)
    bundle.close()

    return bundle.name


if _is_wsl():
    CA_BUNDLE = _windows_ca_bundle()
else:
    import truststore
    truststore.inject_into_ssl()
    CA_BUNDLE = True

import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 "
        "(KHTML, like Gecko) "
        "Chrome/140.0 Safari/537.36"
    )
}

BASE_URL = "https://gasprices.aaa.com/?state="

OUTPUT = "gas_prices.csv"

FIELDNAMES = ["description", "price_per_gallon"]


def fetch_state_prices(state):

    url = f"{BASE_URL}{state}"

    print(f"Downloading {url}...")

    response = requests.get(
        url,
        headers=HEADERS,
        timeout=30,
        verify=CA_BUNDLE
    )

    print(f"HTTP status: {response.status_code}")
    print(f"Downloaded {len(response.text):,} bytes")

    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")

    results = []

    # Find all H3 headings.
    for heading in soup.find_all("h3"):

        description = heading.get_text(" ", strip=True)

        if description:
            description = f"{description}, {state}"

        # Only process headings underneath the Minnesota
        # metro average section.
        if not description:
            continue

        # Look for the next table after the heading.
        table = heading.find_next("table")

        if table is None:
            continue

        rows = table.find_all("tr")

        if len(rows) < 2:
            continue

        # First row contains the column headings.
        header_cells = rows[0].find_all(["th", "td"])

        headers = [
            cell.get_text(" ", strip=True).lower()
            for cell in header_cells
        ]

        # We only want tables containing Regular.
        if "regular" not in headers:
            continue

        regular_index = headers.index("regular")

        # Look for the Current Avg. row.
        for row in rows[1:]:

            cells = row.find_all(["th", "td"])

            if not cells:
                continue

            first_cell = cells[0].get_text(" ", strip=True)

            if first_cell.lower() != "current avg.":
                continue

            if regular_index >= len(cells):
                continue

            price_text = cells[regular_index].get_text(
                " ",
                strip=True
            )

            match = re.search(r"\$([\d.]+)", price_text)

            if not match:
                continue

            price = float(match.group(1))

            results.append({
                "description": description,
                "price_per_gallon": price
            })

            break

    # Remove duplicates
    unique = {}

    for item in results:
        unique[item["description"]] = item

    return list(unique.values())


def main():

    states_input = input(
        "Enter comma-separated state codes "
        "(e.g. IA,MN,WI): "
    ).strip()

    states = [
        state.strip().upper()
        for state in states_input.split(",")
        if state.strip()
    ]

    if not states:
        raise SystemExit("No state codes provided.")

    # Start fresh for this run.
    if os.path.exists(OUTPUT):
        os.remove(OUTPUT)

    with open(
        OUTPUT,
        "w",
        newline="",
        encoding="utf-8"
    ) as f:
        csv.DictWriter(f, fieldnames=FIELDNAMES).writeheader()

    for state in states:

        results = fetch_state_prices(state)

        print()
        print(f"Found {len(results)} locations for {state}:")
        print()

        for item in results:
            print(
                f"{item['description']:<35} "
                f"${item['price_per_gallon']:.4f}"
            )

        with open(
            OUTPUT,
            "a",
            newline="",
            encoding="utf-8"
        ) as f:
            csv.DictWriter(f, fieldnames=FIELDNAMES).writerows(results)

        print()

    print(f"Results written to: {OUTPUT}")


if __name__ == "__main__":
    main()