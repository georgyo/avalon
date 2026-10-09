/**
 * @avalon/common/testing: simulation support (docs/p2p-protocol.md §11.2, §12).
 */
export { MemoryTransport, MemPeer, seededRng, type MemoryTransportOptions } from './memoryTransport.ts';
export {
  simulate, simConfig, simGameSeed, memoCrypto, jobShape, shapeOf, MemJournal, SIM_NAMES, SIM_LOBBY_CODE, SIM_T,
  type SimOptions, type SimResult, type SimSeat, type SimHandle, type DecisionCtx, type ScriptedStrategy, type StrategyName,
} from './simulate.ts';
export { predictDeal } from './predict.ts';
export {
  AdversaryTransport, rawEncode, soulForRaw, cloneEnv, tweakB64, type Adversary, type AdversaryContext,
} from './adversary.ts';
export { legacyAssignRoles } from './legacyAssignRoles.ts';
