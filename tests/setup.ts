// Deterministic property tests: one fixed seed unless FC_SEED is set
// (FC_SEED=$RANDOM npm test explores new cases locally).
import fc from "fast-check";

fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? 20261008) });
