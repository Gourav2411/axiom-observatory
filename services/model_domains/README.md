# Model applicability-domain registries

Axiom does not ship a fabricated applicability domain. Set `AXIOM_ADMET_DOMAIN_REGISTRY` to a reviewed JSON registry only after the reference chemistry, split strategy, endpoint mapping, thresholds, and held-out calibration evidence have been approved.

The accepted schema is `axiom-admet-domain-registry.v1`. It declares a `modelRevision`, a Morgan fingerprint configuration, and endpoint objects containing `referenceSmiles`, `inDomainThreshold`, `borderlineThreshold`, and `calibrationEvidence` with at least `datasetSha256` and `splitStrategy`. Reference chemistry must be licensed for this use; do not commit restricted training data.
