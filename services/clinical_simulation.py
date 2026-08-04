#!/usr/bin/env python3
"""Deterministic, open-source PK/PD research-scenario simulator for the Axiom POC.

This is deliberately a transparent reduced-order model, not PK-Sim/MoBi, a
validated regulatory model, or a replacement for clinical evidence.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

MODEL_VERSION = "axiom-open-pkpd-rk4.1"
SCHEMA_VERSION = "axiom-clinical-simulation.v1"


def finite(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    value = float(value)
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def integer(value, name, minimum, maximum):
    value = finite(value, name, minimum, maximum)
    if value != int(value):
        raise ValueError(f"{name} must be an integer")
    return int(value)


def percentile(values, fraction):
    ordered = sorted(values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] * (upper - position) + ordered[upper] * (position - lower)


def summary(values, digits=4):
    return {
        "p05": round(percentile(values, 0.05), digits),
        "p50": round(percentile(values, 0.50), digits),
        "p95": round(percentile(values, 0.95), digits),
        "mean": round(statistics.fmean(values), digits),
    }


def lognormal_multiplier(rng, cv):
    sigma = math.sqrt(math.log(1.0 + cv * cv))
    return math.exp(rng.gauss(-0.5 * sigma * sigma, sigma))


def derivatives(state, params):
    depot, central, peripheral = state
    concentration_central = central / params["centralVolumeL"]
    concentration_peripheral = peripheral / params["peripheralVolumeL"]
    absorption = params["absorptionRatePerHour"] * depot
    elimination = params["clearanceLPerHour"] * concentration_central
    exchange = params["intercompartmentalClearanceLPerHour"] * (concentration_central - concentration_peripheral)
    return (-absorption, params["bioavailability"] * absorption - elimination - exchange, exchange)


def rk4_step(state, params, dt):
    k1 = derivatives(state, params)
    k2 = derivatives(tuple(state[i] + dt * k1[i] / 2 for i in range(3)), params)
    k3 = derivatives(tuple(state[i] + dt * k2[i] / 2 for i in range(3)), params)
    k4 = derivatives(tuple(state[i] + dt * k3[i] for i in range(3)), params)
    return tuple(max(0.0, state[i] + dt * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6) for i in range(3))


def simulate_subject(config, rng):
    cv = config["betweenSubjectCv"]
    params = {
        "bioavailability": config["bioavailability"],
        "absorptionRatePerHour": config["absorptionRatePerHour"] * lognormal_multiplier(rng, cv * 0.5),
        "clearanceLPerHour": config["clearanceLPerHour"] * lognormal_multiplier(rng, cv),
        "centralVolumeL": config["centralVolumeL"] * lognormal_multiplier(rng, cv * 0.7),
        "peripheralVolumeL": config["peripheralVolumeL"] * lognormal_multiplier(rng, cv * 0.7),
        "intercompartmentalClearanceLPerHour": config["intercompartmentalClearanceLPerHour"] * lognormal_multiplier(rng, cv * 0.6),
    }
    dt = 0.25
    total_hours = max(config["durationHours"], config["doseIntervalHours"] * config["doseCount"])
    steps = int(total_hours / dt) + 1
    dose_steps = {round(index * config["doseIntervalHours"] / dt) for index in range(config["doseCount"])}
    state = (0.0, 0.0, 0.0)
    points = []
    for step in range(steps):
        if step in dose_steps:
            state = (state[0] + config["doseMg"], state[1], state[2])
        time = step * dt
        concentration_mg_l = state[1] / params["centralVolumeL"]
        observed = max(0.0, concentration_mg_l * (1 + rng.gauss(0, config["residualCv"])))
        points.append((time, observed))
        if step < steps - 1:
            state = rk4_step(state, params, dt)
    concentrations = [point[1] for point in points]
    auc = sum((concentrations[i] + concentrations[i - 1]) * dt / 2 for i in range(1, len(concentrations)))
    return {
        "aucMgHourPerL": auc,
        "cmaxNgPerMl": max(concentrations) * 1000,
        "troughNgPerMl": concentrations[-1] * 1000,
        "halfLifeHours": math.log(2) * params["centralVolumeL"] / params["clearanceLPerHour"],
        "averageNgPerMl": auc / total_hours * 1000,
        "curve": points,
    }


def validate_scenario(raw, phase):
    pk = raw.get("pk") if isinstance(raw.get("pk"), dict) else {}
    config = {
        "doseMg": finite(pk.get("doseMg"), "pk.doseMg", 0.01, 5000),
        "doseCount": integer(pk.get("doseCount"), "pk.doseCount", 1, 120),
        "doseIntervalHours": finite(pk.get("doseIntervalHours"), "pk.doseIntervalHours", 1, 336),
        "durationHours": finite(pk.get("durationHours"), "pk.durationHours", 1, 2880),
        "bioavailability": finite(pk.get("bioavailability"), "pk.bioavailability", 0.01, 1),
        "absorptionRatePerHour": finite(pk.get("absorptionRatePerHour"), "pk.absorptionRatePerHour", 0.01, 20),
        "clearanceLPerHour": finite(pk.get("clearanceLPerHour"), "pk.clearanceLPerHour", 0.01, 1000),
        "centralVolumeL": finite(pk.get("centralVolumeL"), "pk.centralVolumeL", 0.1, 5000),
        "peripheralVolumeL": finite(pk.get("peripheralVolumeL"), "pk.peripheralVolumeL", 0.1, 10000),
        "intercompartmentalClearanceLPerHour": finite(pk.get("intercompartmentalClearanceLPerHour"), "pk.intercompartmentalClearanceLPerHour", 0.001, 1000),
        "betweenSubjectCv": finite(pk.get("betweenSubjectCv"), "pk.betweenSubjectCv", 0, 2),
        "residualCv": finite(pk.get("residualCv"), "pk.residualCv", 0, 1),
        "cohortSize": integer(pk.get("cohortSize"), "pk.cohortSize", 20, 2000),
    }
    pd = raw.get("pd") if isinstance(raw.get("pd"), dict) else {}
    if phase == "phase2":
        config["pd"] = {
            "emax": finite(pd.get("emax"), "pd.emax", 0.001, 1000),
            "ec50NgPerMl": finite(pd.get("ec50NgPerMl"), "pd.ec50NgPerMl", 0.001, 1_000_000),
            "placeboChange": finite(pd.get("placeboChange"), "pd.placeboChange", -1000, 1000),
            "endpointSd": finite(pd.get("endpointSd"), "pd.endpointSd", 0.001, 1000),
            "treatmentN": integer(pd.get("treatmentN"), "pd.treatmentN", 10, 5000),
            "controlN": integer(pd.get("controlN"), "pd.controlN", 10, 5000),
            "dropoutRate": finite(pd.get("dropoutRate"), "pd.dropoutRate", 0, 0.8),
            "trialReplicates": integer(pd.get("trialReplicates"), "pd.trialReplicates", 100, 5000),
        }
    return config


def phase_one(config, rng):
    subjects = [simulate_subject(config, rng) for _ in range(config["cohortSize"])]
    sample_times = [round(index * config["durationHours"] / 48, 2) for index in range(49)]
    curves = []
    for time in sample_times:
        index = min(round(time / 0.25), len(subjects[0]["curve"]) - 1)
        concentrations = [subject["curve"][index][1] * 1000 for subject in subjects]
        curves.append({"hour": time, "p05": round(percentile(concentrations, 0.05), 4), "p50": round(percentile(concentrations, 0.5), 4), "p95": round(percentile(concentrations, 0.95), 4)})
    return {
        "population": {"simulatedSubjects": len(subjects), "variabilityModel": "independent log-normal random effects"},
        "exposure": {
            "aucMgHourPerL": summary([item["aucMgHourPerL"] for item in subjects]),
            "cmaxNgPerMl": summary([item["cmaxNgPerMl"] for item in subjects]),
            "troughNgPerMl": summary([item["troughNgPerMl"] for item in subjects]),
            "halfLifeHours": summary([item["halfLifeHours"] for item in subjects]),
        },
        "concentrationTime": curves,
    }


def phase_two(config, rng):
    pk_subjects = [simulate_subject(config, rng) for _ in range(config["cohortSize"])]
    concentrations = [item["averageNgPerMl"] for item in pk_subjects]
    pd = config["pd"]
    effects = [pd["emax"] * value / (pd["ec50NgPerMl"] + value) for value in concentrations]
    expected_effect = statistics.fmean(effects)
    significant = 0
    differences = []
    retained_treatment = max(2, round(pd["treatmentN"] * (1 - pd["dropoutRate"])))
    retained_control = max(2, round(pd["controlN"] * (1 - pd["dropoutRate"])))
    standard_error = pd["endpointSd"] * math.sqrt(1 / retained_treatment + 1 / retained_control)
    for _ in range(pd["trialReplicates"]):
        treatment = pd["placeboChange"] - expected_effect + rng.gauss(0, pd["endpointSd"] / math.sqrt(retained_treatment))
        control = pd["placeboChange"] + rng.gauss(0, pd["endpointSd"] / math.sqrt(retained_control))
        difference = treatment - control
        differences.append(difference)
        z = abs(difference / standard_error)
        if math.erfc(z / math.sqrt(2)) < 0.05:
            significant += 1
    mean_difference = statistics.fmean(differences)
    return {
        "design": {"treatmentN": pd["treatmentN"], "controlN": pd["controlN"], "dropoutRate": pd["dropoutRate"], "trialReplicates": pd["trialReplicates"]},
        "pkBridge": {"averageConcentrationNgPerMl": summary(concentrations), "expectedEmaxEffect": round(expected_effect, 4)},
        "operatingCharacteristics": {
            "modelBasedProbabilityTwoSidedPBelow0_05": round(significant / pd["trialReplicates"], 4),
            "treatmentDifference": summary(differences),
            "meanDifference95Interval": [round(mean_difference - 1.96 * statistics.pstdev(differences), 4), round(mean_difference + 1.96 * statistics.pstdev(differences), 4)],
        },
    }


def run(payload):
    phase = payload.get("phase")
    if phase not in ("phase1", "phase2"):
        raise ValueError("phase must be phase1 or phase2")
    scenario = payload.get("scenario")
    if not isinstance(scenario, dict):
        raise ValueError("scenario must be an object")
    seed = integer(scenario.get("seed", 20260804), "seed", 1, 2_147_483_647)
    config = validate_scenario(scenario, phase)
    canonical_input = json.dumps({"phase": phase, "scenario": scenario}, sort_keys=True, separators=(",", ":"))
    input_hash = hashlib.sha256(canonical_input.encode()).hexdigest()
    result = phase_one(config, random.Random(seed)) if phase == "phase1" else phase_two(config, random.Random(seed))
    output = {
        "schemaVersion": SCHEMA_VERSION,
        "phase": phase,
        "mode": payload.get("mode", "research_scenario"),
        "model": {
            "id": MODEL_VERSION,
            "method": "Two-compartment oral PK with first-order absorption solved by fixed-step RK4; log-normal population variability" + ("; Emax exposure-response and Monte Carlo parallel-arm operating characteristics" if phase == "phase2" else ""),
            "source": "Axiom open-source POC worker",
        },
        "seed": seed,
        "inputSha256": input_hash,
        "scenario": scenario,
        "result": result,
        "provenance": {"worker": "services/clinical_simulation.py", "python": sys.version.split()[0], "createdAt": datetime.now(timezone.utc).isoformat()},
        "boundary": "Model-generated research projection from declared assumptions. It is not a clinical trial, patient data, a validated PBPK platform, dose advice, evidence of safety or efficacy, or a regulatory-grade result.",
    }
    job_id = str(payload.get("jobId", "manual"))
    safe_job_id = "".join(character for character in job_id if character.isalnum() or character in "-_")[:80] or "manual"
    artifact = Path("services/artifacts") / f"clinical-simulation-{safe_job_id}.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text(json.dumps(output, indent=2), encoding="utf-8")
    output["artifactPath"] = artifact.as_posix()
    return output


if __name__ == "__main__":
    try:
        print(json.dumps(run(json.load(sys.stdin)), separators=(",", ":")))
    except Exception as error:  # concise structured failure for the Node worker
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(1)
