"""Local open-source chemistry worker for Axiom Observatory.

This service performs real RDKit standardization and ADMET-AI inference. It
does not claim that predictions are measurements or experimental validation.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import re
import shutil
import statistics
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from rdkit import Chem, DataStructs, rdBase
from rdkit.Chem import AllChem, BRICS, Descriptors, Draw, Lipinski, QED, rdMolDescriptors
from rdkit.Chem.FilterCatalog import FilterCatalog, FilterCatalogParams
from rdkit.Chem.MolStandardize import rdMolStandardize

try:
    ADMET_VERSION = importlib.metadata.version("admet-ai")
    ADMET_IMPORT_ERROR = None
except importlib.metadata.PackageNotFoundError:
    ADMET_VERSION = None
    ADMET_IMPORT_ERROR = "ADMET-AI is not installed."

ADMET_EXECUTION_ENABLED = os.environ.get("AXIOM_ADMET_EXECUTION_ENABLED", "true").strip().lower() not in {
    "0", "false", "no", "off",
}
ADMET_DISABLED_REASON = (
    "ADMET-AI execution is disabled on this resource-constrained web service. "
    "Run it in a separately sized worker or enable AXIOM_ADMET_EXECUTION_ENABLED on an instance with sufficient memory."
)


ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_ROOT = ROOT / "services" / "artifacts"
ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True)
RECEPTOR_ROOT = ROOT / "services" / "receptors"
RECEPTOR_ROOT.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Axiom local chemistry worker", version="0.1.0")
_admet_model: Any = None
_admet_info_loader: Any = None
_admet_lock = threading.Lock()


class MoleculeInput(BaseModel):
    smiles: str = Field(min_length=1, max_length=10_000)
    largest_fragment: bool = True
    neutralize: bool = True
    canonical_tautomer: bool = True
    generate_3d: bool = True


class PredictionInput(BaseModel):
    smiles: str = Field(min_length=1, max_length=10_000)


class Vector3(BaseModel):
    x: float
    y: float
    z: float


class DockingPreparationInput(PredictionInput):
    receptor_id: str = Field(min_length=1, max_length=80)
    center: Vector3
    size: Vector3
    exhaustiveness: int = Field(default=8, ge=1, le=64)
    seed: int = 20260803


class DockingRunInput(DockingPreparationInput):
    receptor_path: str = Field(min_length=1, max_length=500)
    control_smiles: str | None = Field(default=None, max_length=10_000)
    replicates: int = Field(default=3, ge=2, le=5)


class RoutePlanningInput(PredictionInput):
    max_transforms: int = Field(default=6, ge=1, le=12)
    time_limit_seconds: int = Field(default=120, ge=10, le=1800)


def _admet_domain_registry() -> dict[str, Any]:
    configured = os.environ.get("AXIOM_ADMET_DOMAIN_REGISTRY")
    if not configured:
        raise HTTPException(status_code=503, detail="No calibrated ADMET applicability-domain registry is configured.")
    path = Path(configured).resolve()
    if not path.is_file():
        raise HTTPException(status_code=503, detail="The configured ADMET applicability-domain registry does not exist.")
    try:
        registry = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise HTTPException(status_code=503, detail="The configured ADMET applicability-domain registry is invalid.")
    if registry.get("schemaVersion") != "axiom-admet-domain-registry.v1" or not isinstance(registry.get("endpoints"), dict):
        raise HTTPException(status_code=503, detail="The ADMET applicability-domain registry schema is unsupported.")
    return registry


@app.post("/applicability/admet")
def admet_applicability(payload: PredictionInput) -> dict[str, Any]:
    registry = _admet_domain_registry()
    molecule = Chem.MolFromSmiles(payload.smiles)
    if molecule is None:
        raise HTTPException(status_code=422, detail="RDKit could not parse this SMILES structure.")
    fingerprint_config = registry.get("fingerprint", {})
    radius = int(fingerprint_config.get("radius", 2))
    bits = int(fingerprint_config.get("bits", 2048))
    generator = AllChem.GetMorganGenerator(radius=radius, fpSize=bits)
    query = generator.GetFingerprint(molecule)
    endpoints = []
    for endpoint_id, definition in registry["endpoints"].items():
        evidence = definition.get("calibrationEvidence", {})
        references = definition.get("referenceSmiles", [])
        if not references or not evidence.get("datasetSha256") or not evidence.get("splitStrategy"):
            endpoints.append({"id": endpoint_id, "status": "not_evaluable", "reason": "Calibration evidence or reference chemistry is incomplete."})
            continue
        reference_fingerprints = [generator.GetFingerprint(item) for smiles in references if (item := Chem.MolFromSmiles(smiles)) is not None]
        if not reference_fingerprints:
            endpoints.append({"id": endpoint_id, "status": "not_evaluable", "reason": "No valid reference chemistry was available."})
            continue
        similarity = max(DataStructs.BulkTanimotoSimilarity(query, reference_fingerprints))
        in_threshold = float(definition.get("inDomainThreshold", 0.5))
        borderline_threshold = float(definition.get("borderlineThreshold", 0.35))
        status = "in_domain" if similarity >= in_threshold else "borderline" if similarity >= borderline_threshold else "out_of_domain"
        endpoints.append({
            "id": endpoint_id, "status": status, "nearestNeighborTanimoto": similarity,
            "thresholds": {"inDomain": in_threshold, "borderline": borderline_threshold},
            "calibrationEvidence": evidence,
        })
    return {
        "schemaVersion": "axiom-admet-applicability.v1",
        "modelRevision": registry.get("modelRevision"),
        "registrySha256": hashlib.sha256(json.dumps(registry, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
        "fingerprint": {"type": "Morgan", "radius": radius, "bits": bits, "metric": "Tanimoto nearest neighbor"},
        "endpoints": endpoints,
        "boundary": "Domain status is endpoint-specific and only as valid as the configured reference set, split, thresholds, and calibration evidence.",
    }


def _catalog(kind: FilterCatalogParams.FilterCatalogs) -> FilterCatalog:
    params = FilterCatalogParams()
    params.AddCatalog(kind)
    return FilterCatalog(params)


FILTERS = {
    "PAINS": _catalog(FilterCatalogParams.FilterCatalogs.PAINS),
    "BRENK": _catalog(FilterCatalogParams.FilterCatalogs.BRENK),
    "NIH": _catalog(FilterCatalogParams.FilterCatalogs.NIH),
}


def _standardize(payload: MoleculeInput) -> tuple[Chem.Mol, list[str]]:
    molecule = Chem.MolFromSmiles(payload.smiles)
    if molecule is None:
        raise HTTPException(status_code=422, detail="RDKit could not parse this SMILES structure.")

    warnings: list[str] = []
    try:
        molecule = rdMolStandardize.Cleanup(molecule)
        if payload.largest_fragment:
            fragments = Chem.GetMolFrags(molecule, asMols=True, sanitizeFrags=True)
            if len(fragments) > 1:
                molecule = max(fragments, key=lambda item: item.GetNumHeavyAtoms())
                warnings.append(f"Selected the largest fragment from {len(fragments)} disconnected components.")
        if payload.neutralize:
            molecule = rdMolStandardize.Uncharger().uncharge(molecule)
        if payload.canonical_tautomer:
            molecule = rdMolStandardize.TautomerEnumerator().Canonicalize(molecule)
        Chem.SanitizeMol(molecule)
        Chem.AssignStereochemistry(molecule, cleanIt=True, force=True)
    except Exception as error:
        raise HTTPException(status_code=422, detail=f"RDKit standardization failed: {error}") from error
    return molecule, warnings


def _alerts(molecule: Chem.Mol) -> list[dict[str, str]]:
    matches: list[dict[str, str]] = []
    for family, catalog in FILTERS.items():
        for entry in catalog.GetMatches(molecule):
            matches.append({
                "family": family,
                "description": entry.GetDescription(),
                "reference": "RDKit FilterCatalog structural alert",
            })
    return matches


def _three_dimensional_artifact(molecule: Chem.Mol, structure_hash: str) -> dict[str, Any]:
    embedded = Chem.AddHs(Chem.Mol(molecule))
    params = AllChem.ETKDGv3()
    params.randomSeed = 20260803
    status = AllChem.EmbedMolecule(embedded, params)
    if status != 0:
        return {"generated": False, "reason": "RDKit ETKDG could not generate a conformer."}
    optimization = AllChem.MMFFOptimizeMolecule(embedded, maxIters=500)
    sdf_path = ARTIFACT_ROOT / f"{structure_hash}.sdf"
    writer = Chem.SDWriter(str(sdf_path))
    writer.write(embedded)
    writer.close()
    return {
        "generated": True,
        "method": "RDKit ETKDGv3 + MMFF94",
        "randomSeed": 20260803,
        "optimizationStatus": int(optimization),
        "artifact": str(sdf_path.relative_to(ROOT)),
        "boundary": "This is a generated conformer for computational preparation, not an experimentally observed geometry.",
    }


@app.get("/health")
def health() -> dict[str, Any]:
    vina_binary = os.environ.get("AXIOM_VINA_BINARY") or shutil.which("vina")
    aizynth_binary = os.environ.get("AXIOM_AIZYNTHFINDER_BINARY") or shutil.which("aizynthcli")
    aizynth_config = os.environ.get("AXIOM_AIZYNTH_CONFIG")
    return {
        "status": "ok",
        "service": "axiom-local-chemistry-worker",
        "capabilities": {
            "molecule_prep": {
                "available": True,
                "provider": "RDKit",
                "version": rdBase.rdkitVersion,
                "mode": "local_cpu",
            },
            "admet": {
                "available": ADMET_VERSION is not None and ADMET_EXECUTION_ENABLED,
                "installed": ADMET_VERSION is not None,
                "provider": "ADMET-AI",
                "version": ADMET_VERSION,
                "mode": "local_cpu_model_inference",
                "reason": ADMET_DISABLED_REASON if not ADMET_EXECUTION_ENABLED else ADMET_IMPORT_ERROR,
                "loading": "lazy_on_first_prediction",
            },
            "docking": {
                "available": bool(vina_binary),
                "preparationAvailable": True,
                "provider": "Meeko + AutoDock Vina",
                "version": "Meeko 0.7.1",
                "binary": vina_binary,
                "reason": None if vina_binary else "Ligand preparation is installed, but no compatible Vina engine is registered.",
            },
            "retrosynthesis": {
                "available": bool(aizynth_binary and aizynth_config and Path(aizynth_config).is_file()),
                "fragmentAnalysisAvailable": True,
                "provider": "AiZynthFinder",
                "binary": aizynth_binary,
                "config": aizynth_config,
                "reason": None if aizynth_binary and aizynth_config and Path(aizynth_config).is_file() else "AiZynthFinder requires an isolated environment plus expansion policy, optional filter policy, stock files, and AXIOM_AIZYNTH_CONFIG.",
            },
        },
    }


@app.post("/prepare")
def prepare(payload: MoleculeInput) -> dict[str, Any]:
    started = time.perf_counter()
    molecule, warnings = _standardize(payload)
    canonical_smiles = Chem.MolToSmiles(molecule, canonical=True, isomericSmiles=True)
    inchi = Chem.MolToInchi(molecule)
    structure_hash = hashlib.sha256(canonical_smiles.encode("utf-8")).hexdigest()
    descriptors = {
        "molecularFormula": rdMolDescriptors.CalcMolFormula(molecule),
        "molecularWeight": Descriptors.MolWt(molecule),
        "exactMass": Descriptors.ExactMolWt(molecule),
        "logP": Descriptors.MolLogP(molecule),
        "tpsa": rdMolDescriptors.CalcTPSA(molecule),
        "hBondDonors": Lipinski.NumHDonors(molecule),
        "hBondAcceptors": Lipinski.NumHAcceptors(molecule),
        "rotatableBonds": Lipinski.NumRotatableBonds(molecule),
        "rings": rdMolDescriptors.CalcNumRings(molecule),
        "fractionCsp3": rdMolDescriptors.CalcFractionCSP3(molecule),
        "qed": QED.qed(molecule),
    }
    lipinski_violations = [
        name for name, failed in {
            "Molecular weight > 500": descriptors["molecularWeight"] > 500,
            "LogP > 5": descriptors["logP"] > 5,
            "H-bond donors > 5": descriptors["hBondDonors"] > 5,
            "H-bond acceptors > 10": descriptors["hBondAcceptors"] > 10,
        }.items() if failed
    ]
    response = {
        "schemaVersion": "molecule-prep.v1",
        "status": "completed",
        "generated": False,
        "input": {"smiles": payload.smiles},
        "canonicalSmiles": canonical_smiles,
        "inchi": inchi,
        "inchiKey": Chem.InchiToInchiKey(inchi),
        "structureHash": structure_hash,
        "svg": Draw.MolsToGridImage([molecule], molsPerRow=1, subImgSize=(460, 300), useSVG=True),
        "molblock": Chem.MolToMolBlock(molecule),
        "descriptors": descriptors,
        "drugLikeness": {
            "rule": "Lipinski rule of five",
            "violations": lipinski_violations,
            "passes": len(lipinski_violations) <= 1,
            "boundary": "A rule-based prioritization screen, not an ADMET measurement.",
        },
        "structuralAlerts": _alerts(molecule),
        "threeDimensional": _three_dimensional_artifact(molecule, structure_hash) if payload.generate_3d else {"generated": False, "reason": "3D generation was disabled."},
        "warnings": warnings,
        "provenance": {
            "provider": "RDKit",
            "version": rdBase.rdkitVersion,
            "execution": "local_cpu",
            "durationMs": round((time.perf_counter() - started) * 1000, 2),
            "policy": {
                "largestFragment": payload.largest_fragment,
                "neutralize": payload.neutralize,
                "canonicalTautomer": payload.canonical_tautomer,
            },
        },
        "boundary": "This output is deterministic structure preparation and calculated descriptors. It is not activity, toxicity, efficacy, or experimental validation.",
    }
    artifact_path = ARTIFACT_ROOT / f"{structure_hash}.json"
    artifact_path.write_text(json.dumps({**response, "svg": None, "molblock": None}, indent=2), encoding="utf-8")
    response["artifact"] = str(artifact_path.relative_to(ROOT))
    return response


def _get_admet_components() -> tuple[Any, Any]:
    global _admet_model, _admet_info_loader, ADMET_IMPORT_ERROR
    if not ADMET_EXECUTION_ENABLED:
        raise HTTPException(status_code=503, detail=ADMET_DISABLED_REASON)
    if ADMET_VERSION is None:
        raise HTTPException(status_code=503, detail=ADMET_IMPORT_ERROR or "ADMET-AI is unavailable.")
    with _admet_lock:
        if _admet_model is None:
            try:
                from admet_ai import ADMETModel
                from admet_ai.admet_info import get_admet_info

                _admet_model = ADMETModel(num_workers=0)
                _admet_info_loader = get_admet_info
            except Exception as error:
                ADMET_IMPORT_ERROR = str(error)
                raise HTTPException(status_code=503, detail=f"ADMET-AI could not be loaded: {error}") from error
    return _admet_model, _admet_info_loader


@app.post("/admet")
def admet(payload: PredictionInput) -> dict[str, Any]:
    molecule = Chem.MolFromSmiles(payload.smiles)
    if molecule is None:
        raise HTTPException(status_code=422, detail="RDKit could not parse this SMILES structure.")
    canonical_smiles = Chem.MolToSmiles(molecule, canonical=True, isomericSmiles=True)
    started = time.perf_counter()
    model, get_admet_info = _get_admet_components()
    predictions = model.predict(canonical_smiles)
    metadata = get_admet_info().set_index("id").to_dict(orient="index")
    endpoints = []
    for endpoint_id, raw_value in predictions.items():
        if endpoint_id.endswith("_drugbank_approved_percentile"):
            continue
        info = metadata.get(endpoint_id, {})
        value = float(raw_value)
        endpoints.append({
            "id": endpoint_id,
            "name": info.get("name", endpoint_id),
            "category": info.get("category", "Reference percentile" if "percentile" in endpoint_id else "Other"),
            "taskType": info.get("task_type"),
            "units": info.get("units"),
            "species": info.get("species"),
            "value": value,
            "interpretation": (
                "positive-class probability" if info.get("task_type") == "classification" else "model estimate"
            ),
            "performance": {
                "auroc": None if info.get("AUROC") != info.get("AUROC") else info.get("AUROC"),
                "auprc": None if info.get("AUPRC") != info.get("AUPRC") else info.get("AUPRC"),
                "r2": None if info.get("R^2") != info.get("R^2") else info.get("R^2"),
                "mae": None if info.get("MAE") != info.get("MAE") else info.get("MAE"),
            },
            "sourceUrl": info.get("url"),
        })
    highlighted_ids = {
        "HIA_Hou", "Bioavailability_Ma", "Solubility_AqSolDB", "Caco2_Wang", "BBB_Martins",
        "PPBR_AZ", "CYP3A4_Veith", "Half_Life_Obach", "Clearance_Hepatocyte_AZ",
        "hERG", "AMES", "DILI", "ClinTox", "LD50_Zhu",
    }
    result = {
        "schemaVersion": "admet-ai.v1",
        "status": "completed",
        "generated": False,
        "canonicalSmiles": canonical_smiles,
        "endpoints": endpoints,
        "highlights": [item for item in endpoints if item["id"] in highlighted_ids],
        "provenance": {
            "provider": "ADMET-AI",
            "version": ADMET_VERSION,
            "rdkitVersion": rdBase.rdkitVersion,
            "execution": "local_cpu_model_inference",
            "endpointCount": len(endpoints),
            "durationMs": round((time.perf_counter() - started) * 1000, 2),
        },
        "boundary": "These are model predictions from molecular structure and training data. They are not measured safety, toxicity, exposure, or clinical outcomes.",
    }
    structure_hash = hashlib.sha256(canonical_smiles.encode("utf-8")).hexdigest()
    artifact_path = ARTIFACT_ROOT / f"{structure_hash}-admet.json"
    artifact_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    result["artifact"] = str(artifact_path.relative_to(ROOT))
    return result


@app.post("/docking/prepare")
def prepare_docking(payload: DockingPreparationInput) -> dict[str, Any]:
    try:
        from meeko import MoleculePreparation, PDBQTWriterLegacy
        import meeko
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Meeko is unavailable: {error}") from error

    molecule = Chem.MolFromSmiles(payload.smiles)
    if molecule is None:
        raise HTTPException(status_code=422, detail="RDKit could not parse this SMILES structure.")
    canonical_smiles = Chem.MolToSmiles(molecule, canonical=True, isomericSmiles=True)
    molecule = Chem.AddHs(molecule)
    params = AllChem.ETKDGv3()
    params.randomSeed = payload.seed
    if AllChem.EmbedMolecule(molecule, params) != 0:
        raise HTTPException(status_code=422, detail="RDKit could not generate a docking conformer.")
    AllChem.MMFFOptimizeMolecule(molecule, maxIters=500)
    setup = MoleculePreparation().prepare(molecule)[0]
    pdbqt, ok, message = PDBQTWriterLegacy.write_string(setup)
    if not ok:
        raise HTTPException(status_code=422, detail=f"Meeko ligand preparation failed: {message}")

    structure_hash = hashlib.sha256(canonical_smiles.encode("utf-8")).hexdigest()
    ligand_path = ARTIFACT_ROOT / f"{structure_hash}.pdbqt"
    config_path = ARTIFACT_ROOT / f"{structure_hash}-vina-config.json"
    ligand_path.write_text(pdbqt, encoding="utf-8")
    config = {
        "receptorId": payload.receptor_id,
        "ligand": str(ligand_path.relative_to(ROOT)),
        "center": payload.center.model_dump(),
        "size": payload.size.model_dump(),
        "exhaustiveness": payload.exhaustiveness,
        "seed": payload.seed,
        "scoring": "vina",
    }
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return {
        "schemaVersion": "docking-preparation.v1",
        "status": "prepared_waiting_engine",
        "canonicalSmiles": canonical_smiles,
        "ligandArtifact": str(ligand_path.relative_to(ROOT)),
        "configArtifact": str(config_path.relative_to(ROOT)),
        "config": config,
        "provenance": {
            "rdkitVersion": rdBase.rdkitVersion,
            "meekoVersion": getattr(meeko, "__version__", "0.7.1"),
            "conformer": "ETKDGv3 + MMFF94",
            "execution": "local_cpu_preparation",
        },
        "boundary": "The ligand and Vina manifest are prepared. No docking engine ran, so there are no poses, affinities, or binding claims.",
    }


def _safe_receptor_path(value: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = RECEPTOR_ROOT / candidate
    resolved = candidate.resolve()
    if RECEPTOR_ROOT.resolve() not in resolved.parents or resolved.suffix.lower() != ".pdbqt":
        raise HTTPException(status_code=422, detail="Receptors must be PDBQT files stored under services/receptors/.")
    if not resolved.is_file():
        raise HTTPException(status_code=422, detail="The prepared receptor PDBQT file does not exist.")
    return resolved


def _vina_affinity(output: str) -> float | None:
    for line in output.splitlines():
        match = re.match(r"^\s*1\s+(-?\d+(?:\.\d+)?)\s+", line)
        if match:
            return float(match.group(1))
    return None


def _execute_vina(binary: str, receptor: Path, ligand: Path, output: Path, payload: DockingRunInput, seed: int) -> dict[str, Any]:
    command = [
        binary, "--receptor", str(receptor), "--ligand", str(ligand),
        "--center_x", str(payload.center.x), "--center_y", str(payload.center.y), "--center_z", str(payload.center.z),
        "--size_x", str(payload.size.x), "--size_y", str(payload.size.y), "--size_z", str(payload.size.z),
        "--exhaustiveness", str(payload.exhaustiveness), "--seed", str(seed), "--out", str(output),
    ]
    started = time.monotonic()
    completed = subprocess.run(command, capture_output=True, text=True, timeout=900, check=False)
    if completed.returncode != 0:
        raise HTTPException(status_code=422, detail="AutoDock Vina rejected the prepared docking inputs.")
    affinity = _vina_affinity(completed.stdout)
    if affinity is None or not output.is_file():
        raise HTTPException(status_code=422, detail="AutoDock Vina did not produce a parseable scored pose.")
    return {
        "bestAffinity": affinity,
        "poseArtifact": str(output.relative_to(ROOT)),
        "stdoutTail": completed.stdout.splitlines()[-12:],
        "seed": seed,
        "wallTimeSeconds": round(time.monotonic() - started, 3),
        "command": command,
    }


def _replicate_vina(binary: str, receptor: Path, ligand: Path, output_stem: str, payload: DockingRunInput) -> dict[str, Any]:
    runs = []
    for index in range(payload.replicates):
        seed = payload.seed + index
        output = ARTIFACT_ROOT / f"{output_stem}-seed-{seed}.pdbqt"
        runs.append(_execute_vina(binary, receptor, ligand, output, payload, seed))
    affinities = [run["bestAffinity"] for run in runs]
    deviation = statistics.pstdev(affinities)
    return {
        "bestAffinity": min(affinities),
        "meanAffinity": statistics.mean(affinities),
        "affinityStandardDeviation": deviation,
        "replicates": runs,
        "stability": {
            "status": "pass" if deviation <= 1.0 else "fail",
            "thresholdKcalMol": 1.0,
            "method": "population standard deviation across deterministic Vina seed replicates",
        },
    }


@app.post("/docking/run")
def run_docking(payload: DockingRunInput) -> dict[str, Any]:
    vina_binary = os.environ.get("AXIOM_VINA_BINARY") or shutil.which("vina")
    if not vina_binary:
        raise HTTPException(status_code=503, detail="No compatible AutoDock Vina binary is registered in AXIOM_VINA_BINARY or PATH.")
    receptor = _safe_receptor_path(payload.receptor_path)
    prepared = prepare_docking(payload)
    ligand = ROOT / prepared["ligandArtifact"]
    structure_hash = hashlib.sha256(prepared["canonicalSmiles"].encode("utf-8")).hexdigest()
    docked = _replicate_vina(vina_binary, receptor, ligand, f"{structure_hash}-vina-candidate", payload)
    control = {"status": "not_supplied", "boundary": "No known-ligand control was supplied."}
    if payload.control_smiles:
        control_payload = DockingPreparationInput(
            smiles=payload.control_smiles, receptor_id=payload.receptor_id,
            center=payload.center, size=payload.size,
            exhaustiveness=payload.exhaustiveness, seed=payload.seed,
        )
        control_prepared = prepare_docking(control_payload)
        control_ligand = ROOT / control_prepared["ligandArtifact"]
        control_hash = hashlib.sha256(control_prepared["canonicalSmiles"].encode("utf-8")).hexdigest()
        control_run = _replicate_vina(vina_binary, receptor, control_ligand, f"{control_hash}-vina-control", payload)
        control = {
            "status": "score_control_completed",
            "knownLigandSmiles": control_prepared["canonicalSmiles"],
            "bestAffinity": control_run["bestAffinity"],
            "meanAffinity": control_run["meanAffinity"],
            "affinityStandardDeviation": control_run["affinityStandardDeviation"],
            "replicates": control_run["replicates"],
            "stability": control_run["stability"],
            "boundary": "This is a same-box score control, not RMSD redocking validation unless an experimental reference pose is separately supplied and aligned.",
        }
    version = subprocess.run([vina_binary, "--version"], capture_output=True, text=True, timeout=10, check=False).stdout.strip()
    result = {
        "schemaVersion": "vina-docking.v1",
        "status": "completed",
        "canonicalSmiles": prepared["canonicalSmiles"],
        "receptorId": payload.receptor_id,
        "bestAffinity": docked["bestAffinity"],
        "meanAffinity": docked["meanAffinity"],
        "affinityStandardDeviation": docked["affinityStandardDeviation"],
        "replicates": docked["replicates"],
        "stability": docked["stability"],
        "control": control,
        "config": prepared["config"],
        "provenance": {
            "provider": "AutoDock Vina", "binary": vina_binary, "engineVersion": version,
            "baseSeed": payload.seed, "replicateCount": payload.replicates,
            "receptorSha256": hashlib.sha256(receptor.read_bytes()).hexdigest(),
            "execution": "local_subprocess",
        },
        "boundary": "Docking poses and scores are computational prioritization signals, not experimental binding validation.",
    }
    result_path = ARTIFACT_ROOT / f"{structure_hash}-vina-result.json"
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    result["artifact"] = str(result_path.relative_to(ROOT))
    return result


@app.post("/retrosynthesis/fragments")
def retrosynthesis_fragments(payload: PredictionInput) -> dict[str, Any]:
    molecule = Chem.MolFromSmiles(payload.smiles)
    if molecule is None:
        raise HTTPException(status_code=422, detail="RDKit could not parse this SMILES structure.")
    canonical_smiles = Chem.MolToSmiles(molecule, canonical=True, isomericSmiles=True)
    fragments = sorted(BRICS.BRICSDecompose(molecule, keepNonLeafNodes=False, minFragmentSize=2))
    return {
        "schemaVersion": "brics-fragment-analysis.v1",
        "status": "completed",
        "canonicalSmiles": canonical_smiles,
        "fragments": [{"smiles": fragment, "heavyAtoms": Chem.MolFromSmiles(fragment).GetNumHeavyAtoms()} for fragment in fragments],
        "provenance": {
            "provider": "RDKit BRICS",
            "rdkitVersion": rdBase.rdkitVersion,
            "execution": "local_cpu_rule_based_fragmentation",
        },
        "boundary": "BRICS decomposition identifies rule-based synthetic cuts. It is not an AiZynthFinder route, reaction simulation, yield prediction, or proof of laboratory feasibility.",
    }


@app.post("/retrosynthesis/plan")
def retrosynthesis_plan(payload: RoutePlanningInput) -> dict[str, Any]:
    binary = os.environ.get("AXIOM_AIZYNTHFINDER_BINARY") or shutil.which("aizynthcli")
    config_value = os.environ.get("AXIOM_AIZYNTH_CONFIG")
    config = Path(config_value).resolve() if config_value else None
    if not binary or config is None or not config.is_file():
        raise HTTPException(status_code=503, detail="AiZynthFinder route planning requires a binary and AXIOM_AIZYNTH_CONFIG containing expansion policy and stock paths.")
    molecule = Chem.MolFromSmiles(payload.smiles)
    if molecule is None:
        raise HTTPException(status_code=422, detail="RDKit could not parse this SMILES structure.")
    canonical_smiles = Chem.MolToSmiles(molecule, canonical=True, isomericSmiles=True)
    structure_hash = hashlib.sha256(canonical_smiles.encode("utf-8")).hexdigest()
    output = ARTIFACT_ROOT / f"{structure_hash}-routes.json"
    environment = {
        **os.environ,
        "MAX_TRANSFORMS": str(payload.max_transforms),
        "TIME_LIMIT": str(payload.time_limit_seconds),
    }
    completed = subprocess.run(
        [binary, "--config", str(config), "--smiles", canonical_smiles, "--output", str(output), "--nproc", "1"],
        capture_output=True, text=True, timeout=payload.time_limit_seconds + 60, check=False, env=environment,
    )
    if completed.returncode != 0 or not output.is_file():
        raise HTTPException(status_code=422, detail="AiZynthFinder did not produce a route artifact for the configured policy and stock.")
    raw = json.loads(output.read_text(encoding="utf-8"))
    routes = raw if isinstance(raw, list) else raw.get("trees", raw.get("routes", [])) if isinstance(raw, dict) else []
    return {
        "schemaVersion": "aizynthfinder-route-search.v1",
        "status": "completed",
        "canonicalSmiles": canonical_smiles,
        "routes": routes,
        "rawResult": raw,
        "artifact": str(output.relative_to(ROOT)),
        "applicability": {"status": "configured_policy_and_stock", "config": config.name, "limitation": "Coverage is limited by the configured reaction policy and purchasable-stock snapshot."},
        "provenance": {"provider": "AiZynthFinder", "binary": binary, "config": str(config), "execution": "local_subprocess"},
        "boundary": "Routes are template/model-guided proposals against a stock snapshot; they do not predict yield or prove laboratory feasibility.",
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("AXIOM_CHEMISTRY_PORT", "8791"))
    host = os.environ.get("AXIOM_CHEMISTRY_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="warning")
