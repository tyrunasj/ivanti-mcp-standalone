import type { IvantiConnection } from '../../ivanti/connect.js';
import type { Logger } from '../../logger.js';
import type { ObjectGate } from './object-gate.js';

/**
 * What every Ivanti tool needs and nothing more: the connection built at startup, the gate that
 * says which Business Objects this audience may touch, and somewhere to log. Tools never read
 * configuration or the environment — what they may do was decided when they were selected.
 */
export interface IvantiToolDeps {
  connection: IvantiConnection;
  gate: ObjectGate;
  logger: Logger;
}
