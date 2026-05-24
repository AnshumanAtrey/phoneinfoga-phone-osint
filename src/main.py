import asyncio
import os
import re
import subprocess
from datetime import datetime, timezone

from apify import Actor


VALID_SCANNERS = {"googlesearch", "ovh", "numverify", "googlecse"}
E164_PATTERN = re.compile(r"^\+[1-9]\d{6,14}$")


def normalize_number(raw: str) -> str:
    s = (raw or "").strip().replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
    if s and not s.startswith("+"):
        s = "+" + s
    return s


def build_command(number: str, disable: list[str]) -> list[str]:
    cmd = ["phoneinfoga", "scan", "-n", number]
    for scanner in disable:
        if scanner in VALID_SCANNERS:
            cmd.extend(["-D", scanner])
    return cmd


def parse_output(stdout: str, target: str) -> dict:
    record: dict = {
        "target": target,
        "status": "ok",
        "country": None,
        "raw_local": None,
        "local_format": None,
        "international": None,
        "e164": None,
        "carrier": None,
        "line_type": None,
        "valid": None,
        "ovh": None,
        "numverify": None,
        "googlesearch": {},
        "googlecse": None,
        "googlesearch_url_count": 0,
        "scanners_succeeded": 0,
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
    }

    current_scanner: str | None = None
    current_category: str | None = None

    for raw_line in stdout.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()

        m = re.match(r"^Results for (\w+)$", stripped)
        if m:
            current_scanner = m.group(1)
            current_category = None
            continue

        m = re.match(r"^(\d+) scanner\(s\) succeeded$", stripped)
        if m:
            record["scanners_succeeded"] = int(m.group(1))
            continue

        if not current_scanner:
            continue

        if current_scanner == "local":
            if stripped.startswith("Raw local:"):
                record["raw_local"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("Local:"):
                record["local_format"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("E164:"):
                record["e164"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("International:"):
                record["international"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("Country:"):
                record["country"] = stripped.split(":", 1)[1].strip()

        elif current_scanner == "googlesearch":
            if stripped.endswith(":") and not stripped.startswith("URL:"):
                current_category = stripped[:-1]
                record["googlesearch"].setdefault(current_category, [])
            elif stripped.startswith("URL:"):
                url = stripped.split(":", 1)[1].strip()
                cat = current_category or "general"
                record["googlesearch"].setdefault(cat, []).append(url)
                record["googlesearch_url_count"] += 1

        elif current_scanner == "numverify":
            if stripped.startswith("Country:"):
                record["country"] = record["country"] or stripped.split(":", 1)[1].strip()
            elif stripped.startswith("Carrier:"):
                record["carrier"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("Line type:") or stripped.startswith("Line Type:"):
                record["line_type"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("Valid:"):
                record["valid"] = stripped.split(":", 1)[1].strip().lower() == "true"
            else:
                record.setdefault("numverify_raw", []).append(stripped)

        elif current_scanner == "ovh":
            record.setdefault("ovh_raw", []).append(stripped)

        elif current_scanner == "googlecse":
            record.setdefault("googlecse_raw", []).append(stripped)

    if record.get("ovh_raw"):
        record["ovh"] = "\n".join(l for l in record["ovh_raw"] if l)
        del record["ovh_raw"]
    if record.get("numverify_raw"):
        record["numverify"] = "\n".join(l for l in record["numverify_raw"] if l)
        del record["numverify_raw"]
    if record.get("googlecse_raw"):
        record["googlecse"] = "\n".join(l for l in record["googlecse_raw"] if l)
        del record["googlecse_raw"]

    return record


def run_phoneinfoga(number: str, disable: list[str], env: dict, timeout: int = 90) -> tuple[str, int]:
    cmd = build_command(number, disable)
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )
    return proc.stdout + proc.stderr, proc.returncode


async def main() -> None:
    async with Actor:
        Actor.log.info("PhoneInfoga actor starting")

        input_data = await Actor.get_input() or {}
        raw_numbers = input_data.get("numbers") or []
        disable = list(input_data.get("disableScanners") or [])
        numverify_key = (input_data.get("numverifyApiKey") or "").strip()
        gcse_key = (input_data.get("googleCseApiKey") or "").strip()
        gcse_cx = (input_data.get("googleCseCx") or "").strip()

        if not raw_numbers:
            Actor.log.error("No phone numbers provided. Provide at least one E.164 number in 'numbers'.")
            await Actor.fail(status_message="No phone numbers provided")
            return

        env = os.environ.copy()
        if numverify_key:
            env["NUMVERIFY_API_KEY"] = numverify_key
        else:
            if "numverify" not in disable:
                disable.append("numverify")

        if gcse_key and gcse_cx:
            env["GOOGLECSE_CSE_ID"] = gcse_cx
            env["GOOGLECSE_API_KEY"] = gcse_key
        else:
            if "googlecse" not in disable:
                disable.append("googlecse")

        ok = 0
        failed = 0
        invalid = 0
        total = len(raw_numbers)

        for idx, raw in enumerate(raw_numbers, 1):
            number = normalize_number(str(raw))
            if not E164_PATTERN.match(number):
                Actor.log.warning(f"[{idx}/{total}] Skipping invalid E.164 number: {raw!r}")
                await Actor.push_data({
                    "target": raw,
                    "status": "invalid_format",
                    "error": "Number must be E.164 international format (e.g. +14155552671)",
                    "scrapedAt": datetime.now(timezone.utc).isoformat(),
                })
                invalid += 1
                continue

            Actor.log.info(f"[{idx}/{total}] Scanning {number}")
            try:
                output, rc = run_phoneinfoga(number, disable, env)
            except subprocess.TimeoutExpired:
                Actor.log.warning(f"[{idx}/{total}] {number} timed out after 90s")
                await Actor.push_data({
                    "target": number,
                    "status": "timeout",
                    "error": "phoneinfoga scan exceeded 90s timeout",
                    "scrapedAt": datetime.now(timezone.utc).isoformat(),
                })
                failed += 1
                continue
            except Exception as exc:
                Actor.log.exception(f"[{idx}/{total}] {number} crashed: {exc}")
                await Actor.push_data({
                    "target": number,
                    "status": "error",
                    "error": str(exc),
                    "scrapedAt": datetime.now(timezone.utc).isoformat(),
                })
                failed += 1
                continue

            record = parse_output(output, number)
            if rc != 0 and record["scanners_succeeded"] == 0:
                record["status"] = "scan_failed"
                record["error"] = f"phoneinfoga returned exit {rc}"
                failed += 1
            else:
                ok += 1

            await Actor.push_data(record)

        summary = {
            "target": "__summary__",
            "status": "summary",
            "total_numbers": total,
            "successful": ok,
            "failed": failed,
            "invalid_format": invalid,
            "disabled_scanners": disable,
            "scrapedAt": datetime.now(timezone.utc).isoformat(),
        }
        await Actor.push_data(summary)
        Actor.log.info(f"Done. ok={ok} failed={failed} invalid={invalid} total={total}")


if __name__ == "__main__":
    asyncio.run(main())
